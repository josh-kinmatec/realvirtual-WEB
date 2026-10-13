// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * kinematics/create-actions — actions that CREATE structure: kinematic axes,
 * PLC signal nodes, LogicSteps and "group into empty" containers.
 *
 * A kinematic is a NEW axis node carrying `Kinematic` (+ later `Drive`); the
 * parts it moves are never reparented, they only gain a `Group` membership (see
 * `group-actions`). Every action here is one undo unit through the AssetDocument:
 * the node, its components and any rename share one composite.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../../core/rv-viewer';
import type { AssetDocument } from '../../../core/editor/rv-asset-document';
import { assetOpHeader, dedupeComponentKey } from '../../../core/editor/rv-asset-ops';
import { deepCloneJSON } from '../../../core/ops/rv-op-utils';
import { NodeRegistry } from '../../../core/engine/rv-node-registry';
import { isModelRoot } from '../../../core/engine/rv-model-root';
import {
  componentData,
  extrasOf,
  kinematicGroupNamesInScene,
  keysMatching,
  selectAndRevealExclusive,
  selectPath,
  settle,
} from '../editor-action-utils';
import { pruneDescendantPaths } from '../delete-selection';
import type { QuickEditContext } from './quick-edit-context';

// ─── Kinematic axes ─────────────────────────────────────────────────────

/** Name the axis node and its group start from when none is given. */
const DEFAULT_KINEMATIC_NAME = 'Kinematic';

/**
 * Create the axis node (top level, named after the group) and stamp the linked
 * `Kinematic` on it. Does NOT open a transaction — callers own the undo unit
 * (`createKinematicWithGroup`, `groupSelection`). Returns the node's path.
 */
export async function createKinematicNode(doc: AssetDocument, groupName: string): Promise<string> {
  const path = await doc.createEmptyNode(null, groupName);
  doc.addComponent(path, 'Kinematic', { GroupName: groupName, IntegrateGroupEnable: true });
  return path;
}

/** Group names and top-level node names already in use. */
function takenNames(viewer: RVViewer): Set<string> {
  const taken = kinematicGroupNamesInScene(viewer);
  for (const name of viewer.groups?.getGroupNames() ?? []) taken.add(name);
  for (const child of viewer.currentModelRoot?.children ?? []) taken.add(child.name);
  return taken;
}

/**
 * Create a new kinematic axis: an empty top-level node with a `Kinematic`
 * component linked to a fresh group of the same name. ONE transaction; the axis
 * is selected and revealed (every other top-level branch collapses).
 *
 * `name` is used as given when free; a name already taken — by a kinematic's
 * group, a registry group or a top-level node — gets a `_N` suffix. Without a
 * name the first free `Kinematic`, `Kinematic_1`, … is used. Returns the axis
 * path, or null when it could not be created.
 */
export async function createKinematicWithGroup(
  viewer: RVViewer,
  doc: AssetDocument,
  name?: string,
): Promise<string | null> {
  const base = (name ?? '').trim() || DEFAULT_KINEMATIC_NAME;
  const taken = takenNames(viewer);
  let groupName = base;
  for (let n = 1; taken.has(groupName); n++) groupName = `${base}_${n}`;

  let path: string | null = null;
  await doc.withTransaction(`Add kinematic "${groupName}"`, async () => {
    path = await createKinematicNode(doc, groupName);
    await settle(doc);
  });
  await settle(doc);
  if (path) selectAndRevealExclusive(viewer, path);
  return path;
}

// ─── Group into an empty container ──────────────────────────────────────

/**
 * Move the selection into one new empty node ("Group"), preserving every world
 * pose. Descendants of other selected nodes are pruned (they travel with their
 * ancestor). The container is created under the nodes' common parent when they
 * share one, else at the asset root. One composite — one undo undoes the whole
 * grouping. Selects the container; returns its path, or null when nothing moved.
 */
export async function groupIntoEmpty(
  viewer: RVViewer,
  doc: AssetDocument,
  paths: readonly string[],
): Promise<string | null> {
  const movable = pruneDescendantPaths(paths).filter((p) => {
    const node = viewer.registry?.getNode(p);
    return !!node && !!node.parent && !isModelRoot(node, viewer.currentModelRoot);
  });
  if (movable.length === 0) return null;

  const parents = new Set(movable.map((p) => viewer.registry?.getNode(p)?.parent ?? null));
  const sharedParent = parents.size === 1 ? [...parents][0] : null;
  const parentPath = sharedParent && !isModelRoot(sharedParent, viewer.currentModelRoot)
    ? viewer.registry?.getPathForNode(sharedParent) ?? NodeRegistry.computeNodePath(sharedParent)
    : null;

  let groupPath: string | null = null;
  await doc.withTransaction(`Group ${movable.length} object${movable.length === 1 ? '' : 's'}`, async () => {
    groupPath = await doc.createEmptyNode(parentPath, 'Group');
    await doc.reparentNodesBatch(movable, groupPath);
  });
  await settle(doc);
  if (groupPath) selectPath(viewer, groupPath);
  return groupPath;
}

// ─── PLC signals ────────────────────────────────────────────────────────

type SignalDirection = 'Input' | 'Output';
type SignalKind = 'Bool' | 'Int' | 'Float';

const SIGNAL_KEY_RE = /^PLC(Input|Output)(Bool|Int|Float)(?:_\d+)?$/;
const SIGNAL_TYPE_RE = /^PLC(Input|Output)(Bool|Int|Float)$/;

/** The initial `Status.Value` of a signal of this kind. */
function seedValue(kind: SignalKind): boolean | number {
  return kind === 'Bool' ? false : 0;
}

/** Carry a signal value over to another datatype (true → 1, 1.7 → 1 for Int). */
function convertValue(value: unknown, kind: SignalKind): boolean | number {
  if (kind === 'Bool') return typeof value === 'number' ? value !== 0 : value === true;
  const n = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  return kind === 'Int' ? Math.trunc(safe) : safe;
}

/**
 * Create a PLC signal node under `parentPath`: a render-free empty named after
 * its type, carrying the signal component with a zero/false `Status.Value`. The
 * signal's name is the node's name (no `Name` field is stamped), so renaming the
 * node renames the signal. One transaction; the new node is selected. Returns
 * its path, or null for an unknown type / parent.
 */
export async function createSignalNode(
  viewer: RVViewer,
  doc: AssetDocument,
  parentPath: string,
  sigType: string,
): Promise<string | null> {
  const match = SIGNAL_TYPE_RE.exec(sigType);
  if (!match || !viewer.registry?.getNode(parentPath)) return null;
  const kind = match[2] as SignalKind;

  let path: string | null = null;
  await doc.withTransaction(`Add signal ${sigType}`, async () => {
    path = await doc.createEmptyNode(parentPath, sigType);
    doc.addComponent(path, sigType, { Status: { Value: seedValue(kind) } });
    await settle(doc);
  });
  await settle(doc);
  if (path) selectPath(viewer, path);
  return path;
}

/** The signal component key on a node, or null. */
function signalKeyOf(node: Object3D): string | null {
  return keysMatching(extrasOf(node), SIGNAL_KEY_RE)[0] ?? null;
}

/**
 * Swap a signal component for another one in a single undo unit: remove the old
 * key, add the new one with the old fields (`Status.Value` converted by `value`).
 */
async function replaceSignal(
  doc: AssetDocument,
  path: string,
  node: Object3D,
  oldKey: string,
  newType: string,
  kind: SignalKind,
  label: string,
): Promise<void> {
  const rv = extrasOf(node);
  const prevFields = deepCloneJSON(componentData(rv, oldKey) ?? {});
  const status = (prevFields['Status'] && typeof prevFields['Status'] === 'object'
    ? prevFields['Status'] : {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {
    ...prevFields,
    Status: { ...status, Value: 'Value' in status ? convertValue(status['Value'], kind) : seedValue(kind) },
  };
  const remaining: Record<string, unknown> = { ...(rv ?? {}) };
  delete remaining[oldKey];
  await doc.withTransaction(label, async () => {
    await doc.applyOp({
      ...assetOpHeader(), kind: 'removeComponent', nodePath: path, componentType: oldKey, prevFields,
    });
    doc.addComponent(path, dedupeComponentKey(remaining, newType), fields);
    await settle(doc);
  });
  await settle(doc);
}

/** Convert a signal node to another datatype, keeping direction and value. */
export async function convertSignalType(
  viewer: RVViewer,
  doc: AssetDocument,
  path: string,
  target: SignalKind,
): Promise<void> {
  const node = viewer.registry?.getNode(path);
  const key = node ? signalKeyOf(node) : null;
  const match = key ? SIGNAL_KEY_RE.exec(key) : null;
  if (!node || !match || match[2] === target) return;
  await replaceSignal(doc, path, node, key!, `PLC${match[1] as SignalDirection}${target}`, target,
    `Convert signal to ${target}`);
}

/** Flip a signal node between PLC input and output (value preserved). */
export async function toggleSignalDirection(
  viewer: RVViewer,
  doc: AssetDocument,
  path: string,
): Promise<void> {
  const node = viewer.registry?.getNode(path);
  const key = node ? signalKeyOf(node) : null;
  const match = key ? SIGNAL_KEY_RE.exec(key) : null;
  if (!node || !match) return;
  const flipped: SignalDirection = match[1] === 'Input' ? 'Output' : 'Input';
  await replaceSignal(doc, path, node, key!, `PLC${flipped}${match[2]}`, match[2] as SignalKind,
    `Signal to PLC ${flipped.toLowerCase()}`);
}

// ─── LogicSteps ─────────────────────────────────────────────────────────

/** One addable LogicStep type. `fields` are the initial component values. */
export interface LogicStepPaletteEntry {
  type: string;
  label: string;
  fields: Record<string, unknown>;
}

/**
 * The LogicSteps the web runtime executes, with the same defaults the logic
 * engine assumes for an absent field (`rv-logic-engine.ts`), so a freshly added
 * step behaves exactly like its field-less form. IK / camera / statistics steps
 * are left out: the engine treats the last two as no-ops and IK is not part of
 * the community editor.
 */
export const LOGIC_STEP_PALETTE: LogicStepPaletteEntry[] = [
  { type: 'LogicStep_SerialContainer', label: 'Sequence (serial)', fields: {} },
  { type: 'LogicStep_ParallelContainer', label: 'Parallel', fields: {} },
  { type: 'LogicStep_Delay', label: 'Delay', fields: { Duration: 1 } },
  { type: 'LogicStep_SetSignalBool', label: 'Set signal (bool)', fields: { SetToTrue: true } },
  { type: 'LogicStep_WaitForSignalBool', label: 'Wait for signal (bool)', fields: { WaitForTrue: true } },
  { type: 'LogicStep_SetSignalFloat', label: 'Set signal (float)', fields: { Value: 0 } },
  {
    type: 'LogicStep_WaitForSignalFloat', label: 'Wait for signal (float)',
    fields: { Comparison: 'Equals', Value: 0, Tolerance: 0.0001 },
  },
  { type: 'LogicStep_WaitForSensor', label: 'Wait for sensor', fields: { WaitForOccupied: true } },
  { type: 'LogicStep_DriveTo', label: 'Drive to position', fields: { Destination: 0, Relative: false } },
  { type: 'LogicStep_StartDriveTo', label: 'Start drive to position', fields: { Destination: 0, Relative: false } },
  { type: 'LogicStep_SetDriveSpeed', label: 'Set drive speed', fields: { Speed: 100 } },
  { type: 'LogicStep_StartDriveSpeed', label: 'Start drive speed', fields: { Speed: 100 } },
  { type: 'LogicStep_WaitForDrivesAtTarget', label: 'Wait for drives at target', fields: { Drives: [] } },
  { type: 'LogicStep_Enable', label: 'Enable / disable object', fields: { Enable: true } },
  { type: 'LogicStep_GripPick', label: 'Grip: pick', fields: { Blocking: false } },
  { type: 'LogicStep_GripPlace', label: 'Grip: place', fields: { Blocking: false } },
  { type: 'LogicStep_JumpOnSignal', label: 'Jump on signal', fields: { JumpOn: true, JumpToStep: '' } },
  { type: 'LogicStep_Pause', label: 'Pause (breakpoint)', fields: {} },
];

/** Readable node name for a step: `LogicStep_DriveTo` → `DriveTo`. */
function stepNodeName(stepType: string): string {
  return stepType.replace(/^LogicStep_/, '') || 'Step';
}

/**
 * Add a LogicStep next to / under the Quick Edit context node.
 *
 * Steps sequence ONE PER NODE (the engine reads one `LogicStep_*` per node), so:
 *
 *  - a context node without a step gets the step itself;
 *  - a Serial/Parallel container gets the step as a new CHILD (children are what
 *    the container runs);
 *  - any other node that already has a step gets a new SIBLING right after it.
 *
 * One transaction; the node carrying the step is selected. Returns its path, or
 * null for an unknown step type / no context node.
 */
export async function addLogicStep(
  viewer: RVViewer,
  doc: AssetDocument,
  qe: QuickEditContext,
  stepType: string,
): Promise<string | null> {
  const entry = LOGIC_STEP_PALETTE.find((s) => s.type === stepType);
  const node = qe.node;
  if (!entry || !node || !qe.nodePath) return null;
  const fields = deepCloneJSON(entry.fields);

  let targetPath: string | null = null;
  await doc.withTransaction(`Add ${entry.label}`, async () => {
    if (!qe.hasLogicStep) {
      targetPath = qe.nodePath;
      doc.addComponent(qe.nodePath!, stepType, fields);
    } else if (qe.isLogicContainer) {
      targetPath = await doc.createEmptyNode(qe.nodePath, stepNodeName(stepType));
      doc.addComponent(targetPath, stepType, fields);
    } else {
      const parent = node.parent;
      const parentPath = parent && !isModelRoot(parent, viewer.currentModelRoot)
        ? viewer.registry?.getPathForNode(parent) ?? NodeRegistry.computeNodePath(parent)
        : null;
      const index = parent ? parent.children.indexOf(node) + 1 : undefined;
      targetPath = await doc.createEmptyNode(parentPath, stepNodeName(stepType), index !== undefined ? { index } : undefined);
      doc.addComponent(targetPath, stepType, fields);
    }
    await settle(doc);
  });
  await settle(doc);
  if (targetPath) selectPath(viewer, targetPath);
  return targetPath;
}
