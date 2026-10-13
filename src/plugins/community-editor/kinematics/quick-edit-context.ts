// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * kinematics/quick-edit-context — what the current selection IS, for the Quick
 * Edit rules ("can I add a Drive here? is there already one? is this a signal?").
 *
 * Pure analysis of `node.userData.realvirtual` and the ancestor chain; reads the
 * scene, writes nothing. All key tests are `_N`-dedup tolerant (`Drive_1`,
 * `Sensor_2`, …).
 *
 * A selected PLC signal node is REBASED onto its parent: the signal itself is
 * reported through `hasSignal` / `signalType` / `signalNodePath`, while the
 * context node (`node` / `nodePath` and every component flag) is the parent — the
 * thing a signal belongs to and the thing the rest of the Quick Edit rules are
 * about. Without a parent (the signal is the root) the signal node stays itself.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../../core/rv-viewer';
import type { SelectionSnapshot } from '../../../core/engine/rv-selection-manager';
import { NodeRegistry } from '../../../core/engine/rv-node-registry';
import {
  DRIVE_KEY_RE,
  GROUP_KEY_RE,
  KINEMATIC_KEY_RE,
  LOGIC_STEP_KEY_RE,
  extrasOf,
  keysMatching,
} from '../editor-action-utils';

const SENSOR_KEY_RE = /^Sensor(_\d+)?$/;
const TRANSPORT_SURFACE_KEY_RE = /^TransportSurface(_\d+)?$/;
const SERIAL_CONTAINER_KEY_RE = /^LogicStep_SerialContainer(_\d+)?$/;
const PARALLEL_CONTAINER_KEY_RE = /^LogicStep_ParallelContainer(_\d+)?$/;
const SIGNAL_KEY_RE = /^PLC(Input|Output)(Bool|Int|Float)(_\d+)?$/;
/** A drive BEHAVIOR (`Drive_Simple`, `Drive_Cylinder_1`) — not the Drive itself. */
const DRIVE_BEHAVIOR_KEY_RE = /^Drive_[A-Za-z]/;
const DEDUP_SUFFIX_RE = /_\d+$/;

/** The selection analysis the Quick Edit rules and the create actions consume. */
export interface QuickEditContext {
  /** Anything selected at all. */
  hasSelection: boolean;
  /** Exactly one node selected. */
  isSingle: boolean;
  selectionCount: number;
  /** The context node (the PARENT when a signal node is selected), or null. */
  node: Object3D | null;
  nodePath: string | null;

  /** The selected node is a PLC signal. */
  hasSignal: boolean;
  /** Base type of that signal (`PLCOutputBool`), dedup suffix stripped. */
  signalType: string | null;
  signalNodePath: string | null;

  hasDrive: boolean;
  hasKinematic: boolean;
  hasSensor: boolean;
  hasGroup: boolean;
  hasTransportSurface: boolean;
  /** Drive behaviors already on the node (base names, e.g. `Drive_Simple`). */
  existingDriveBehaviors: Set<string>;
  /** Components other than Hidden, signals and LogicSteps. */
  hasOtherRvComponents: boolean;

  hasLogicStep: boolean;
  /** Base type of the node's LogicStep (`LogicStep_Delay`), or null. */
  logicStepType: string | null;
  /** The node's LogicStep is a Serial/Parallel container (children belong inside it). */
  isLogicContainer: boolean;

  /** The node or an ancestor carries a TransportSurface. */
  isUnderTransportSurface: boolean;
  /** The node or an ancestor carries a LogicStep_SerialContainer. */
  isUnderSerialContainer: boolean;
}

function emptyContext(selectionCount: number): QuickEditContext {
  return {
    hasSelection: selectionCount > 0,
    isSingle: selectionCount === 1,
    selectionCount,
    node: null, nodePath: null,
    hasSignal: false, signalType: null, signalNodePath: null,
    hasDrive: false, hasKinematic: false, hasSensor: false, hasGroup: false, hasTransportSurface: false,
    existingDriveBehaviors: new Set(),
    hasOtherRvComponents: false,
    hasLogicStep: false, logicStepType: null, isLogicContainer: false,
    isUnderTransportSurface: false, isUnderSerialContainer: false,
  };
}

/** Does the node or any ancestor carry a component matching `re`? */
function selfOrAncestorHas(node: Object3D, re: RegExp): boolean {
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    if (keysMatching(extrasOf(cur), re).length > 0) return true;
  }
  return false;
}

/** Ignored when deciding whether a node carries "other" components. */
function isIgnoredForOtherComponents(key: string): boolean {
  return key === 'Hidden' || key.startsWith('__') || SIGNAL_KEY_RE.test(key) || LOGIC_STEP_KEY_RE.test(key);
}

/** Analyse a selection snapshot against the live scene. */
export function computeQuickEditContext(
  viewer: Pick<RVViewer, 'registry'>,
  selection: Pick<SelectionSnapshot, 'selectedPaths' | 'primaryPath'>,
): QuickEditContext {
  const ctx = emptyContext(selection.selectedPaths.length);
  const registry = viewer.registry;
  const primaryPath = selection.primaryPath
    ?? selection.selectedPaths[selection.selectedPaths.length - 1]
    ?? null;
  if (!primaryPath || !registry) return ctx;

  const selected = registry.getNode(primaryPath);
  if (!selected) return ctx;

  let node = selected;
  let nodePath = primaryPath;

  // A selected signal node: report it, then judge everything else by its parent.
  const signalKey = keysMatching(extrasOf(selected), SIGNAL_KEY_RE)[0];
  if (signalKey) {
    ctx.hasSignal = true;
    ctx.signalType = signalKey.replace(DEDUP_SUFFIX_RE, '');
    ctx.signalNodePath = primaryPath;
    if (selected.parent) {
      node = selected.parent;
      nodePath = registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
    }
  }

  ctx.node = node;
  ctx.nodePath = nodePath;

  const rv = extrasOf(node);
  const keys = rv ? Object.keys(rv) : [];
  ctx.hasDrive = keys.some((k) => DRIVE_KEY_RE.test(k));
  ctx.hasKinematic = keys.some((k) => KINEMATIC_KEY_RE.test(k));
  ctx.hasSensor = keys.some((k) => SENSOR_KEY_RE.test(k));
  ctx.hasGroup = keys.some((k) => GROUP_KEY_RE.test(k));
  ctx.hasTransportSurface = keys.some((k) => TRANSPORT_SURFACE_KEY_RE.test(k));
  for (const key of keys) {
    if (DRIVE_BEHAVIOR_KEY_RE.test(key)) ctx.existingDriveBehaviors.add(key.replace(DEDUP_SUFFIX_RE, ''));
  }
  ctx.hasOtherRvComponents = keys.some((k) => !isIgnoredForOtherComponents(k));

  const stepKey = keys.find((k) => LOGIC_STEP_KEY_RE.test(k));
  if (stepKey) {
    ctx.hasLogicStep = true;
    ctx.logicStepType = stepKey.replace(DEDUP_SUFFIX_RE, '');
    ctx.isLogicContainer = SERIAL_CONTAINER_KEY_RE.test(stepKey) || PARALLEL_CONTAINER_KEY_RE.test(stepKey);
  }

  ctx.isUnderTransportSurface = selfOrAncestorHas(node, TRANSPORT_SURFACE_KEY_RE);
  ctx.isUnderSerialContainer = selfOrAncestorHas(node, SERIAL_CONTAINER_KEY_RE);
  return ctx;
}
