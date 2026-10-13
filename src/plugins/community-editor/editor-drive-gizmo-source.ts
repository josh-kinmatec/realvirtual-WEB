// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-drive-gizmo-source — the authoring adapter that lets the drive-axis
 * gizmo (and the drag preview / `web_editor_verify_drive`) work on a Drive that
 * only exists as rv_extras data.
 *
 * In editor mode a Drive is authoring data, not a live `RVDrive`: nothing is
 * instantiated until the asset is saved and reloaded. This source reads the
 * node's Drive config on EVERY access — an inspector edit or a `set_field` op
 * changes the gizmo immediately, and a removed Drive collapses the axis to zero
 * (the gizmo hides itself on a zero axis) instead of leaving a stale one. It
 * holds no document and writes nothing; a preview only moves `currentPosition`.
 *
 * Conventions mirror `RVDrive` exactly (axis table, `ReverseDirection`,
 * mm → local offset with the parent-frame scale correction, defaults) so the
 * gizmo draws the same thing the running drive will do.
 */

import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { DriveGizmoSource } from '../../core/engine/drive-gizmo-source';
import { DriveDirection, directionToGltfAxis, isRotation } from '../../core/engine/rv-coordinate-utils';
import { MM_TO_METERS } from '../../core/engine/rv-constants';
import { parentScaleAlong } from '../../core/engine/rv-drive-units';
import { DRIVE_KEY_RE, componentData, extrasOf, keysMatching } from './editor-action-utils';

/** `RVDrive` defaults for the fields the gizmo reads (see `rv-drive.ts`). */
const DEFAULT_LOWER_LIMIT = -180;
const DEFAULT_UPPER_LIMIT = 180;

const _dir = new Vector3();

/** The node's first Drive component data (any `Drive_N` key), or undefined. */
function driveConfigOf(node: Object3D): Record<string, unknown> | undefined {
  const rv = extrasOf(node);
  const key = keysMatching(rv, DRIVE_KEY_RE).find((k) => componentData(rv, k));
  return key ? componentData(rv, key) : undefined;
}

/** Known direction, or null (unknown strings behave like "no motion"). */
function directionOf(cfg: Record<string, unknown> | undefined): DriveDirection | null {
  const d = cfg?.['Direction'];
  return typeof d === 'string' && (Object.values(DriveDirection) as string[]).includes(d)
    ? d as DriveDirection
    : null;
}

function numberOf(cfg: Record<string, unknown> | undefined, field: string, fallback: number): number {
  const v = cfg?.[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The authoring gizmo source for one node; see the module header. */
class EditorDriveGizmoSource implements DriveGizmoSource {
  private _previewPosition = 0;
  private _previewHome: Quaternion | null = null;

  constructor(readonly node: Object3D) {}

  private get cfg(): Record<string, unknown> | undefined { return driveConfigOf(this.node); }

  get isRotary(): boolean {
    const dir = directionOf(this.cfg);
    return dir !== null && isRotation(dir);
  }
  get UseLimits(): boolean { return this.cfg?.['UseLimits'] === true; }
  get LowerLimit(): number { return numberOf(this.cfg, 'LowerLimit', DEFAULT_LOWER_LIMIT); }
  get UpperLimit(): number { return numberOf(this.cfg, 'UpperLimit', DEFAULT_UPPER_LIMIT); }
  get Offset(): number { return numberOf(this.cfg, 'Offset', 0); }
  /** Home pose = position 0; a drag preview moves it. */
  get currentPosition(): number { return this._previewPosition; }
  // No simulation in the editor: nothing runs, nothing jogs.
  get isRunning(): boolean { return false; }
  get jogForward(): boolean { return false; }
  get jogBackward(): boolean { return false; }

  getAxis(out: Vector3): Vector3 {
    const cfg = this.cfg;
    const dir = directionOf(cfg);
    if (!cfg || dir === null) return out.set(0, 0, 0);
    out.copy(directionToGltfAxis(dir));
    if (cfg['ReverseDirection'] === true) out.negate();
    return out;
  }

  getHomeLocalQuaternion(out: Quaternion): Quaternion {
    // The node's own quaternion IS the authored home — unless a rotary preview
    // is turning it right now, in which case the driver pinned the pre-drag one.
    return out.copy(this._previewHome ?? this.node.quaternion);
  }

  positionToLocalOffset(pos: number): number {
    // Same conversion as RVDrive: mm → metres, then into the PARENT's units
    // (a CAD subtree is millimetres; see rv-drive-units). `getAxis` is already
    // in the node frame, the home orientation carries it into the parent frame.
    _dir.set(0, 0, 0);
    this.getAxis(_dir).applyQuaternion(this.getHomeLocalQuaternion(new Quaternion()));
    return pos / MM_TO_METERS / parentScaleAlong(this.node, _dir);
  }

  setPreviewPosition(pos: number): void { this._previewPosition = pos; }
  setPreviewHome(homeQuat: Quaternion): void { this._previewHome = (this._previewHome ?? new Quaternion()).copy(homeQuat); }
  endPreview(): void {
    this._previewPosition = 0;
    this._previewHome = null;
  }
}

/**
 * The gizmo source for the Drive on `path`, or null when the node does not exist
 * or carries no Drive. The source stays valid across edits of the Drive config.
 */
export function resolveEditorDriveGizmoSource(viewer: RVViewer, path: string): DriveGizmoSource | null {
  const node = viewer.registry?.getNode(path) ?? null;
  if (!node || !driveConfigOf(node)) return null;
  return new EditorDriveGizmoSource(node);
}
