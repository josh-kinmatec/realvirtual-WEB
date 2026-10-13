// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-preview-driver — the editor's implementation of the `DriveDragDriver` seam.
 *
 * The drive-axis gizmo and `web_editor_verify_drive` turn a gesture into a drive
 * POSITION (mm for linear, degrees for rotary) and hand it here. In the editor a
 * Drive is authoring data, not a live component, so nothing moves by itself: this
 * driver moves the axis node the way `RVDrive.applyToNode` would, carries every
 * member of the axis' kinematic group along with it, and puts everything back
 * exactly afterwards. It writes NO op: a preview is never part of the document.
 *
 *  - `preview`  — pose the axis (and its group) at `ctx.position`; the first call
 *                 snapshots the home pose.
 *  - `release`  — spring back to home over a few hundred ms, then restore exactly.
 *  - `cancel`   — restore the snapshot immediately (Esc, interruption, pre-export).
 *
 * Motion mirrors `RVDrive.applyToNode`:
 *   rotary: localQuat = homeQuat ⊗ Euler(axis · angle)
 *   linear: localPos  = homePos + (homeQuat ⊗ axis) · offset(position)
 */

import { Euler, MathUtils, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { DriveDragContext, DriveDragDriver } from '../../core/engine/drive-drag-driver';
import { ensureMovableTransform, refreshWorldMatricesDeep } from '../../core/engine/rv-node-transform';

const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;
const SPRING_MS = 320;
const SPRING_STEP_MS = 16;

/** The few viewer members the driver touches (typed structurally, like `ViewerHost`). */
interface PreviewViewer {
  groups?: { get(name: string): { nodes: Object3D[] } | undefined } | null;
  markRenderDirty?: () => void;
  markShadowsDirty?: () => void;
}

interface LocalPose {
  node: Object3D;
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  autoUpdate: boolean;
  matrixAutoUpdate: boolean;
  /** World matrix at snapshot time — the reference the group delta is applied to. */
  world: Matrix4;
}

interface Snapshot {
  axis: LocalPose;
  members: LocalPose[];
  lastPosition: number;
  timer: ReturnType<typeof setInterval> | null;
}

const _axis = new Vector3();
const _euler = new Euler();
const _delta = new Quaternion();
const _axisWorldInv = new Matrix4();
const _deltaWorld = new Matrix4();
const _target = new Matrix4();
const _parentInv = new Matrix4();
const _local = new Matrix4();

function poseOf(node: Object3D): LocalPose {
  return {
    node,
    position: node.position.clone(),
    quaternion: node.quaternion.clone(),
    scale: node.scale.clone(),
    autoUpdate: node.matrixWorldAutoUpdate,
    matrixAutoUpdate: node.matrixAutoUpdate,
    world: node.matrixWorld.clone(),
  };
}

function restorePose(p: LocalPose): void {
  p.node.position.copy(p.position);
  p.node.quaternion.copy(p.quaternion);
  p.node.scale.copy(p.scale);
  p.node.matrixAutoUpdate = p.matrixAutoUpdate;
  p.node.matrixWorldAutoUpdate = p.autoUpdate;
  p.node.updateMatrix();
}

function isDescendant(node: Object3D, ancestor: Object3D): boolean {
  for (let p: Object3D | null = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/** Group names an axis node integrates (its `Kinematic*` components' `GroupName`). */
function groupNamesOf(node: Object3D): string[] {
  const rv = (node.userData as Record<string, unknown>)?.['realvirtual'] as Record<string, unknown> | undefined;
  if (!rv) return [];
  const names: string[] = [];
  for (const key of Object.keys(rv)) {
    if (!KINEMATIC_KEY_RE.test(key)) continue;
    const name = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
    if (typeof name === 'string' && name) names.push(name);
  }
  return names;
}

function capture(ctx: DriveDragContext): Snapshot {
  const viewer = ctx.viewer as unknown as PreviewViewer;
  const node = ctx.node;
  // Frozen static CAD nodes would not follow a local-matrix write — same unfreeze
  // the transform executor performs before it moves anything.
  ensureMovableTransform(node);
  node.updateWorldMatrix(true, false);
  const members: LocalPose[] = [];
  for (const name of groupNamesOf(node)) {
    for (const m of viewer.groups?.get(name)?.nodes ?? []) {
      // A member below the axis already moves with it; counting it twice would
      // double its motion.
      if (m === node || isDescendant(m, node)) continue;
      if (members.some((p) => p.node === m)) continue;
      ensureMovableTransform(m);
      m.updateWorldMatrix(true, false);
      members.push(poseOf(m));
    }
  }
  return { axis: poseOf(node), members, lastPosition: ctx.position, timer: null };
}

function applyPosition(ctx: DriveDragContext, snap: Snapshot, position: number): void {
  const { source, node } = ctx;
  source.getAxis(_axis);
  if (_axis.lengthSq() < 1e-6) return;                 // Virtual drive: nothing to move
  const pos = position + (source.Offset ?? 0);
  const home = snap.axis;

  if (source.isRotary) {
    _euler.set(_axis.x * MathUtils.degToRad(pos), _axis.y * MathUtils.degToRad(pos), _axis.z * MathUtils.degToRad(pos), 'XYZ');
    _delta.setFromEuler(_euler);
    node.quaternion.copy(home.quaternion).multiply(_delta);
  } else {
    const offset = source.positionToLocalOffset(pos);
    node.position.copy(home.position);
    _axis.multiplyScalar(offset).applyQuaternion(home.quaternion);
    node.position.add(_axis);
  }
  node.updateMatrix();
  refreshWorldMatricesDeep(node);

  // World-space delta of the axis, applied to every member of its group.
  if (snap.members.length > 0) {
    _axisWorldInv.copy(home.world).invert();
    _deltaWorld.multiplyMatrices(node.matrixWorld, _axisWorldInv);
    for (const m of snap.members) {
      const parent = m.node.parent;
      _target.multiplyMatrices(_deltaWorld, m.world);
      if (parent) {
        parent.updateWorldMatrix(true, false);
        _parentInv.copy(parent.matrixWorld).invert();
        _local.multiplyMatrices(_parentInv, _target);
      } else {
        _local.copy(_target);
      }
      _local.decompose(m.node.position, m.node.quaternion, m.node.scale);
      m.node.updateMatrix();
      refreshWorldMatricesDeep(m.node);
    }
  }

  source.setPreviewHome?.(home.quaternion);
  source.setPreviewPosition?.(position);
  const viewer = ctx.viewer as unknown as PreviewViewer;
  viewer.markRenderDirty?.();
  viewer.markShadowsDirty?.();
}

function restoreAll(ctx: DriveDragContext, snap: Snapshot): void {
  if (snap.timer) { clearInterval(snap.timer); snap.timer = null; }
  restorePose(snap.axis);
  for (const m of snap.members) restorePose(m);
  refreshWorldMatricesDeep(snap.axis.node);
  for (const m of snap.members) refreshWorldMatricesDeep(m.node);
  ctx.source.endPreview?.();
  const viewer = ctx.viewer as unknown as PreviewViewer;
  viewer.markRenderDirty?.();
  viewer.markShadowsDirty?.();
}

/** One preview session per viewer: owns the home-pose snapshots of the axes being previewed. */
export class DriveDragPreview implements DriveDragDriver {
  private readonly _snapshots = new Map<Object3D, Snapshot>();

  /** The viewer is accepted for symmetry with the other editor tools; contexts carry their own. */
  constructor(_viewer?: unknown) { /* nothing to hold */ }

  preview(ctx: DriveDragContext): void {
    let snap = this._snapshots.get(ctx.node);
    if (!snap) {
      snap = capture(ctx);
      this._snapshots.set(ctx.node, snap);
    }
    // A new gesture interrupts a spring-back that is still running.
    if (snap.timer) { clearInterval(snap.timer); snap.timer = null; }
    snap.lastPosition = ctx.position;
    applyPosition(ctx, snap, ctx.position);
  }

  release(ctx: DriveDragContext): void {
    const snap = this._snapshots.get(ctx.node);
    if (!snap) return;
    if (snap.timer) clearInterval(snap.timer);
    const from = snap.lastPosition;
    // Home is the position at which the drive does not displace the node at all.
    const homePosition = -(ctx.source.Offset ?? 0);
    const t0 = performance.now();
    snap.timer = setInterval(() => {
      const t = Math.min(1, (performance.now() - t0) / SPRING_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      applyPosition(ctx, snap, from + (homePosition - from) * eased);
      if (t >= 1) {
        restoreAll(ctx, snap);
        this._snapshots.delete(ctx.node);
      }
    }, SPRING_STEP_MS);
  }

  cancel(ctx: DriveDragContext): void {
    const snap = this._snapshots.get(ctx.node);
    if (!snap) return;
    restoreAll(ctx, snap);
    this._snapshots.delete(ctx.node);
  }

  /** Stop every spring-back timer and drop every snapshot (editor deactivation). */
  dispose(): void {
    for (const snap of this._snapshots.values()) if (snap.timer) clearInterval(snap.timer);
    this._snapshots.clear();
  }
}