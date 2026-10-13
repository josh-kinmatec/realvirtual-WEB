// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * group-actions — Group / Kinematic membership edits for the asset editor.
 *
 * The model (see recipes/kinematize-cad-import.md):
 *
 *  - A **group** is a name on a `Group` component (`Group`, `Group_1`, …). A
 *    node can carry several. Membership is ASSIGNMENT, never reparenting — CAD
 *    parts keep their place in the hierarchy.
 *  - A **kinematic axis** is a separate node carrying `Kinematic` with
 *    `GroupName` + `IntegrateGroupEnable`; its group's members move with it.
 *  - A group is *kinematic* exactly when some `Kinematic` component references
 *    it. Joining a kinematic group REPLACES a node's other kinematic
 *    membership (a part cannot ride two axes) but leaves non-kinematic groups
 *    (visibility groups like "Covers") untouched.
 *
 * Every function that writes does so in ONE transaction (one undo step) via the
 * AssetDocument; the component key is deduped here, at op creation, so replay
 * is deterministic (`Group`, `Group_1`, … — a key freed by a removal is reused).
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { AssetDocument } from '../../core/editor/rv-asset-document';
import { assetOpHeader, dedupeComponentKey } from '../../core/editor/rv-asset-ops';
import { deepCloneJSON } from '../../core/ops/rv-op-utils';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import type { ContextMenuItem } from '../../core/hmi/context-menu-store';
import { getActiveAssetContext } from '../../core/editor/active-asset-store';
import {
  GROUP_KEY_RE,
  componentData,
  extrasOf,
  forEachModelNode,
  hasKinematicComponent,
  kinematicGroupNamesInScene,
  kinematicGroupNamesOf,
  keysMatching,
  selectAndRevealExclusive,
  selectPath,
  settle,
  syncKinematicGroupMarks,
} from './editor-action-utils';
import { createKinematicNode } from './kinematics/create-actions';

// ─── Queries ────────────────────────────────────────────────────────────

/** `GroupName` of a Group component's data, or null. */
function groupNameOf(data: Record<string, unknown> | undefined): string | null {
  const name = data?.['GroupName'];
  return typeof name === 'string' && name ? name : null;
}

/** Does the node carry a Group component naming `groupName` (any Group* key)? */
export function nodeHasGroupNamed(node: Object3D, groupName: string): boolean {
  const rv = extrasOf(node);
  return keysMatching(rv, GROUP_KEY_RE).some((k) => groupNameOf(componentData(rv, k)) === groupName);
}

/** Names of the user-facing (non-kinematic) groups, for the assign menu. */
export function listGroupNamesForMenu(viewer: RVViewer): string[] {
  const groups = viewer.groups;
  if (!groups) return [];
  return groups.getGroupNames().filter((name) => !groups.isKinematic(name));
}

/** One entry per distinct linked kinematic group, labeled by the axis node. */
export function listKinematicsForMenu(viewer: RVViewer): Array<{ label: string; groupName: string }> {
  const out: Array<{ label: string; groupName: string }> = [];
  const seen = new Set<string>();
  forEachModelNode(viewer, (node) => {
    for (const groupName of kinematicGroupNamesOf(node)) {
      if (seen.has(groupName)) continue;
      seen.add(groupName);
      out.push({ label: node.name || groupName, groupName });
    }
  });
  return out;
}

/** Does any selected node carry a Group component? */
export function selectionHasAnyGroup(viewer: RVViewer, paths: readonly string[]): boolean {
  for (const path of paths) {
    const node = viewer.registry?.getNode(path);
    if (node && keysMatching(extrasOf(node), GROUP_KEY_RE).length > 0) return true;
  }
  return false;
}

/** Does a Kinematic component anywhere in the scene reference `groupName`? */
export function sceneHasKinematicForGroup(viewer: RVViewer, groupName: string): boolean {
  return kinematicGroupNamesInScene(viewer).has(groupName);
}

/** The group members referenced by the Kinematic components on the selection. */
export function kinematicGroupNodesForSelection(viewer: RVViewer, paths: readonly string[]): Object3D[] {
  const out = new Set<Object3D>();
  for (const path of paths) {
    const node = viewer.registry?.getNode(path);
    if (!node) continue;
    for (const name of kinematicGroupNamesOf(node)) {
      for (const member of viewer.groups?.get(name)?.nodes ?? []) out.add(member);
    }
  }
  return [...out];
}

export { syncKinematicGroupMarks };

// ─── Membership planning ────────────────────────────────────────────────

/** Component keys (`Group`, `Group_1`, …) of the node's memberships in OTHER
 *  kinematic groups — the ones joining `targetGroup` replaces. */
function otherKinematicMembershipKeys(
  node: Object3D,
  targetGroup: string,
  kinematicGroups: ReadonlySet<string>,
): string[] {
  const rv = extrasOf(node);
  const keys: string[] = [];
  for (const key of keysMatching(rv, GROUP_KEY_RE)) {
    const name = groupNameOf(componentData(rv, key));
    if (name && name !== targetGroup && kinematicGroups.has(name)) keys.push(key);
  }
  return keys;
}

/**
 * Queue the ops that make `node` a member of `groupName`: remove its other
 * kinematic memberships, then add a (deduped) `Group` component. Must run inside
 * a transaction owned by the caller.
 */
async function assignNodeToGroup(
  doc: AssetDocument,
  path: string,
  node: Object3D,
  groupName: string,
  kinematicGroups: ReadonlySet<string>,
): Promise<void> {
  const rv = extrasOf(node);
  const removed = otherKinematicMembershipKeys(node, groupName, kinematicGroups);
  for (const key of removed) {
    const prevFields = deepCloneJSON(componentData(rv, key) ?? {});
    await doc.applyOp({
      ...assetOpHeader(), kind: 'removeComponent', nodePath: path, componentType: key, prevFields,
    });
  }
  // Dedupe against what the node will carry AFTER the removals, so a freed key
  // is reused instead of leaving a gap (`Group_1` next to no `Group`).
  const remaining: Record<string, unknown> = { ...(rv ?? {}) };
  for (const key of removed) delete remaining[key];
  doc.addComponent(path, dedupeComponentKey(remaining, 'Group'), { GroupName: groupName });
}

/** Resolve paths to assignable nodes: present, not an axis, not already a member. */
function assignable(
  viewer: RVViewer,
  paths: readonly string[],
  groupName: string,
  skipPath?: string,
): Array<{ path: string; node: Object3D }> {
  const out: Array<{ path: string; node: Object3D }> = [];
  const seen = new Set<Object3D>();
  for (const path of paths) {
    if (path === skipPath) continue;
    const node = viewer.registry?.getNode(path);
    if (!node || seen.has(node)) continue;
    if (hasKinematicComponent(node)) continue; // axes never become members
    if (nodeHasGroupNamed(node, groupName)) continue;
    seen.add(node);
    out.push({ path, node });
  }
  return out;
}

// ─── Edits ──────────────────────────────────────────────────────────────

/**
 * Assign the selection to the kinematic group `name`, creating the axis node
 * (a top-level node named after the group, carrying the linked `Kinematic`,
 * selected afterwards) when no Kinematic references that group yet.
 *
 * ONE transaction. A no-op (empty name, empty selection, everything already a
 * member) records nothing — the new axis is only created when at least one node
 * actually joined, so a no-op never leaves an orphan axis behind.
 */
export async function groupSelection(
  viewer: RVViewer,
  doc: AssetDocument,
  paths: readonly string[],
  name: string,
): Promise<void> {
  const groupName = (name ?? '').trim();
  if (!groupName || paths.length === 0) return;
  const targets = assignable(viewer, paths, groupName);
  if (targets.length === 0) return;

  // The group is (or is about to become) kinematic: joining it replaces other
  // kinematic membership.
  const kinematicGroups = new Set(kinematicGroupNamesInScene(viewer));
  const needsAxis = !kinematicGroups.has(groupName);
  kinematicGroups.add(groupName);

  let axisPath: string | null = null;
  await doc.withTransaction(`Group ${targets.length} object${targets.length === 1 ? '' : 's'} into "${groupName}"`, async () => {
    for (const t of targets) await assignNodeToGroup(doc, t.path, t.node, groupName, kinematicGroups);
    if (needsAxis) axisPath = await createKinematicNode(doc, groupName);
    await settle(doc);
  });
  await settle(doc);

  syncKinematicGroupMarks(viewer);
  if (axisPath) selectAndRevealExclusive(viewer, axisPath);
}

/**
 * Remove every `Group*` component from the selection (one transaction). The
 * removal ops carry a CLONE of the component data as `prevFields`, so undo does
 * not share a mutable object with the live extras.
 */
export async function ungroupSelection(
  viewer: RVViewer,
  doc: AssetDocument,
  paths: readonly string[],
): Promise<void> {
  const removals: Array<{ path: string; key: string; prevFields: Record<string, unknown> }> = [];
  for (const path of paths) {
    const node = viewer.registry?.getNode(path);
    if (!node) continue;
    const rv = extrasOf(node);
    for (const key of keysMatching(rv, GROUP_KEY_RE)) {
      removals.push({ path, key, prevFields: deepCloneJSON(componentData(rv, key) ?? {}) });
    }
  }
  if (removals.length === 0) return;
  await doc.withTransaction(`Ungroup ${removals.length} membership${removals.length === 1 ? '' : 's'}`, async () => {
    for (const r of removals) {
      await doc.applyOp({
        ...assetOpHeader(), kind: 'removeComponent', nodePath: r.path, componentType: r.key, prevFields: r.prevFields,
      });
    }
  });
  await settle(doc);
}

/**
 * Add nodes to an EXISTING kinematic's group (`groupName`, driven by the axis at
 * `kinPath`). Skips — silently — the axis itself, other kinematic axes, nodes
 * already in the group and unresolvable paths; nodes in another kinematic group
 * are moved over. ONE transaction, none when nothing is assignable. The axis is
 * re-selected afterwards either way (the Quick Edit "armed axis" flow).
 */
export async function autoAssignToKinematic(
  viewer: RVViewer,
  doc: AssetDocument,
  paths: readonly string[],
  groupName: string,
  kinPath: string,
): Promise<void> {
  const targets = assignable(viewer, paths, groupName, kinPath);
  if (targets.length > 0) {
    const kinematicGroups = new Set(kinematicGroupNamesInScene(viewer));
    kinematicGroups.add(groupName);
    await doc.withTransaction(`Assign ${targets.length} object${targets.length === 1 ? '' : 's'} to "${groupName}"`, async () => {
      for (const t of targets) await assignNodeToGroup(doc, t.path, t.node, groupName, kinematicGroups);
      await settle(doc);
    });
    await settle(doc);
    syncKinematicGroupMarks(viewer);
  }
  selectPath(viewer, kinPath);
}

// ─── Context-menu rows ──────────────────────────────────────────────────

/** The selection a menu action should act on: the whole selection when the
 *  right-clicked node is part of it, else just that node. */
function menuTargetPaths(viewer: RVViewer, clicked: string): string[] {
  const selected = viewer.selectionManager?.getSnapshot().selectedPaths ?? [];
  return selected.includes(clicked) ? [...selected] : [clicked];
}

/**
 * "Assign to kinematic" submenu rows: one per kinematic in the scene, plus a
 * trailing "New kinematic…" input row that creates the axis. The actions resolve
 * the document at click time (the menu outlives any one document).
 */
export function buildKinematicMenuItems(viewer: RVViewer): ContextMenuItem[] {
  const items: ContextMenuItem[] = listKinematicsForMenu(viewer).map(({ label, groupName }) => ({
    id: `kinematic-assign:${groupName}`,
    label,
    action: (target) => {
      const ctx = getActiveAssetContext();
      if (!ctx) return;
      const kinPath = findAxisPath(viewer, groupName);
      if (!kinPath) return;
      void autoAssignToKinematic(ctx.viewer, ctx.doc, menuTargetPaths(viewer, target.path), groupName, kinPath);
    },
  }));
  items.push({
    id: 'kinematic-new',
    label: 'New kinematic…',
    input: {
      placeholder: 'Kinematic name',
      onSubmit: (value, target) => {
        const ctx = getActiveAssetContext();
        if (!ctx) return;
        void groupSelection(ctx.viewer, ctx.doc, menuTargetPaths(viewer, target.path), value);
      },
    },
  });
  return items;
}

function findAxisPath(viewer: RVViewer, groupName: string): string | null {
  let path: string | null = null;
  forEachModelNode(viewer, (node) => {
    if (path || !kinematicGroupNamesOf(node).includes(groupName)) return;
    path = viewer.registry?.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
  });
  return path;
}
