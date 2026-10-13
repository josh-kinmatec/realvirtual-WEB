// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-action-utils — small helpers shared by the community editor's action
 * modules (kinematics / groups / delete / select).
 *
 * Everything here reads the live scene through `viewer.registry` /
 * `viewer.currentModelRoot` and the rv_extras on `node.userData.realvirtual`;
 * nothing writes. Writes always go through the AssetDocument op log in the
 * action modules themselves.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { AssetDocument } from '../../core/editor/rv-asset-document';
import { GROUP_KEY_RE } from '../../core/engine/rv-group-sync';

export { GROUP_KEY_RE };

/** Kinematic component keys in rv_extras, tolerant of the `_N` dedup suffix. */
export const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;
/** Drive component keys in rv_extras (`Drive`, `Drive_1`, …). Drive BEHAVIORS
 *  (`Drive_Simple`) are deliberately not matched. */
export const DRIVE_KEY_RE = /^Drive(_\d+)?$/;
/** LogicStep component keys (`LogicStep_Delay`, `LogicStep_Delay_1`, …). */
export const LOGIC_STEP_KEY_RE = /^LogicStep_/;

/** Plugin id of the hierarchy / inspector plugin that owns `selectAndReveal`. */
const HIERARCHY_PLUGIN_ID = 'rv-extras-editor';

/** The one hierarchy-plugin method the editor actions use. */
interface HierarchyReveal {
  selectAndRevealExclusive?(path: string): void;
}

/** rv_extras of a node (`undefined` when it carries none). */
export function extrasOf(node: Object3D | null | undefined): Record<string, unknown> | undefined {
  const rv = (node?.userData as Record<string, unknown> | undefined)?.['realvirtual'];
  return rv && typeof rv === 'object' ? rv as Record<string, unknown> : undefined;
}

/** Component data under `key`, as a plain record (`undefined` for a non-object). */
export function componentData(
  rv: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const data = rv?.[key];
  return data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
}

/** All keys of `rv` matching `re`, in insertion order. */
export function keysMatching(rv: Record<string, unknown> | undefined, re: RegExp): string[] {
  return rv ? Object.keys(rv).filter((k) => re.test(k)) : [];
}

/** Non-empty `GroupName`s referenced by the node's Kinematic components. */
export function kinematicGroupNamesOf(node: Object3D | null | undefined): string[] {
  const rv = extrasOf(node);
  const out: string[] = [];
  for (const key of keysMatching(rv, KINEMATIC_KEY_RE)) {
    const name = componentData(rv, key)?.['GroupName'];
    if (typeof name === 'string' && name) out.push(name);
  }
  return out;
}

/** Does the node carry at least one Kinematic component (linked or not)? */
export function hasKinematicComponent(node: Object3D | null | undefined): boolean {
  return keysMatching(extrasOf(node), KINEMATIC_KEY_RE).length > 0;
}

/** Visit every node of the loaded model (no-op without a model root). */
export function forEachModelNode(viewer: RVViewer, visit: (node: Object3D) => void): void {
  viewer.currentModelRoot?.traverse(visit);
}

/** `GroupName`s that at least one Kinematic component in the scene references. */
export function kinematicGroupNamesInScene(viewer: RVViewer): Set<string> {
  const names = new Set<string>();
  forEachModelNode(viewer, (node) => {
    for (const n of kinematicGroupNamesOf(node)) names.add(n);
  });
  return names;
}

/**
 * Re-derive which registry groups are kinematic from the scene's Kinematic
 * components. The loader marks them once at load; the editor adds and removes
 * axes afterwards, and the registry does not follow on its own. Idempotent;
 * call it after any edit that creates a Kinematic or changes its group (the
 * editor lifecycle may also run it on `groups-changed`).
 */
export function syncKinematicGroupMarks(viewer: RVViewer): void {
  const groups = viewer.groups;
  if (!groups) return;
  for (const name of kinematicGroupNamesInScene(viewer)) groups.markAsKinematic(name);
}

/** Path of the node whose Kinematic component references `groupName`, or null. */
export function findKinematicPathForGroup(viewer: RVViewer, groupName: string): string | null {
  let found: Object3D | null = null;
  forEachModelNode(viewer, (node) => {
    if (found) return;
    if (kinematicGroupNamesOf(node).includes(groupName)) found = node;
  });
  if (!found) return null;
  return viewer.registry?.getPathForNode(found) ?? null;
}

/** Wait for the op queue to drain. The detached mutators (`addComponent`,
 *  `transformNode`, …) return before their op has applied; anything that reads
 *  the scene afterwards must settle first. Tolerates a document double without
 *  `whenIdle` (unit tests that only record ops). */
export async function settle(doc: AssetDocument): Promise<void> {
  const idle = (doc as unknown as { whenIdle?: () => Promise<void> }).whenIdle;
  if (typeof idle === 'function') await idle.call(doc);
}

/** Select `path` the way a click does. */
export function selectPath(viewer: RVViewer, path: string): void {
  viewer.selectionManager?.select(path);
}

/** Select `path` and ask the hierarchy to reveal it exclusively (every other
 *  top-level branch collapses). The plugin is optional — without a hierarchy
 *  panel the selection alone has to do. */
export function selectAndRevealExclusive(viewer: RVViewer, path: string): void {
  viewer.selectionManager?.select(path);
  const plugin = viewer.getPlugin<RVViewerPlugin & HierarchyReveal>(HIERARCHY_PLUGIN_ID);
  plugin?.selectAndRevealExclusive?.(path);
}

/** Registry path of a node, falling back to the structural path. */
export function pathOfNode(viewer: RVViewer, node: Object3D, fallback: (n: Object3D) => string): string {
  return viewer.registry?.getPathForNode(node) ?? fallback(node);
}
