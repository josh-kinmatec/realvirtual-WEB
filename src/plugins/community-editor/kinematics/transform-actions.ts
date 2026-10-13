// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * kinematics/transform-actions — the Quick Edit transform and pivot tools.
 *
 * Two families:
 *
 *  - **Move the node** (`zeroLocalPosition`, `rotate90`, `toGround`): a plain
 *    `transformNode` op. Children follow the node, exactly like moving a parent.
 *  - **Move the PIVOT** (`pivotToBottom`, `pivotToObjectCenter`, `alignYUp`,
 *    `centerKinematicToGroup`, `pivotToCircle`): the node's own transform
 *    changes while every DIRECT child keeps its WORLD pose, so the geometry stays
 *    put and only the origin the drive rotates/slides about moves. One composite
 *    op (one undo step). Grandchildren hang under a compensated child and need
 *    nothing; kinematic group members are not children of the axis at all, so
 *    they are untouched by construction.
 *
 * All edits go through `AssetDocument` (op log), never straight onto the scene.
 */

import { Box3, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferAttribute, InterleavedBufferAttribute, Mesh, Object3D } from 'three';
import type { RVViewer } from '../../../core/rv-viewer';
import type { AssetDocument } from '../../../core/editor/rv-asset-document';
import type { NodeTransform } from '../../../core/editor/rv-asset-ops';
import { NodeRegistry } from '../../../core/engine/rv-node-registry';
import { ensureMovableTransform } from '../../../core/engine/rv-node-transform';
import { isModelRoot } from '../../../core/engine/rv-model-root';
import { kinematicGroupNamesOf } from '../editor-action-utils';

const _v = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();

/** Above this many vertices the exact (per-vertex) bounds fall back to the
 *  conservative geometry-bounding-box path — keeps one click from stalling. */
const EXACT_BOUNDS_VERTEX_BUDGET = 2_000_000;

/** Tolerances below which a pose change counts as "nothing to do". */
const EPS_POS = 1e-9;
const EPS_QUAT = 1e-12;

/** Runtime helpers (gizmos, overlays) never take part in bounds or centers. */
function isRuntimeHelper(node: Object3D): boolean {
  return node.name.startsWith('_') || node.userData?._rvGizmo === true;
}

/** Visit `node` and its descendants, skipping runtime-helper subtrees. */
function traverseContent(node: Object3D, visit: (n: Object3D) => void): void {
  if (isRuntimeHelper(node)) return;
  visit(node);
  for (const child of node.children) traverseContent(child, visit);
}

function meshesUnder(node: Object3D): Mesh[] {
  const out: Mesh[] = [];
  traverseContent(node, (n) => {
    const mesh = n as Mesh;
    if (mesh.isMesh && mesh.geometry?.getAttribute('position')) out.push(mesh);
  });
  return out;
}

/** World-space bounding box of everything under `node`; null when it has no geometry. */
function worldBounds(node: Object3D): Box3 | null {
  const meshes = meshesUnder(node);
  if (meshes.length === 0) return null;
  let vertices = 0;
  for (const mesh of meshes) vertices += mesh.geometry.getAttribute('position').count;
  const precise = vertices <= EXACT_BOUNDS_VERTEX_BUDGET;
  const box = new Box3();
  for (const mesh of meshes) box.expandByObject(mesh, precise);
  return box.isEmpty() ? null : box;
}

/** Mean of all vertex positions under `node`, in world space; null without geometry.
 *  "Vertex center" rather than bounds center: a ring-shaped bearing seat or an
 *  L-shaped bracket has a bounds center off the part, the vertex mean is the
 *  point a hinge pin actually sits at for symmetric parts. */
function worldVertexCenter(node: Object3D): Vector3 | null {
  const sum = new Vector3();
  let count = 0;
  for (const mesh of meshesUnder(node)) {
    const pos = mesh.geometry.getAttribute('position') as BufferAttribute | InterleavedBufferAttribute;
    mesh.updateWorldMatrix(true, false);
    const e = mesh.matrixWorld.elements;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      sum.x += e[0] * x + e[4] * y + e[8] * z + e[12];
      sum.y += e[1] * x + e[5] * y + e[9] * z + e[13];
      sum.z += e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    count += pos.count;
  }
  return count === 0 ? null : sum.divideScalar(count);
}

/** Local TRS of a node, as the `transformNode` op payload.
 *
 *  A loader-frozen node has a baked `matrixWorld` and possibly stale local TRS —
 *  the executor unfreezes it when the op applies, so the snapshot must be taken
 *  from the same trustworthy state or undo would restore a wrong `prev`. */
export function snapshotLocal(node: Object3D): NodeTransform {
  if (!node.matrixWorldAutoUpdate) ensureMovableTransform(node);
  return {
    position: node.position.toArray() as [number, number, number],
    quaternion: node.quaternion.toArray() as [number, number, number, number],
    scale: node.scale.toArray() as [number, number, number],
  };
}

function decompose(m: Matrix4): NodeTransform {
  const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
  m.decompose(p, q, s);
  return {
    position: p.toArray() as [number, number, number],
    quaternion: q.toArray() as [number, number, number, number],
    scale: s.toArray() as [number, number, number],
  };
}

function sameTransform(a: NodeTransform, b: NodeTransform): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.position[i] - b.position[i]) > EPS_POS) return false;
    if (Math.abs(a.scale[i] - b.scale[i]) > EPS_POS) return false;
  }
  const dot = a.quaternion[0] * b.quaternion[0] + a.quaternion[1] * b.quaternion[1]
    + a.quaternion[2] * b.quaternion[2] + a.quaternion[3] * b.quaternion[3];
  return Math.abs(1 - Math.abs(dot)) < EPS_QUAT;
}

function pathOf(viewer: RVViewer, node: Object3D): string {
  return viewer.registry?.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
}

/** A resolvable, movable node — the model root and unknown paths yield null. */
function movableNode(viewer: RVViewer, path: string): Object3D | null {
  const node = viewer.registry?.getNode(path) ?? null;
  if (!node || isModelRoot(node, viewer.currentModelRoot)) return null;
  return node;
}

/** Refresh the baked world matrices the pivot maths reads. */
function refreshWorld(viewer: RVViewer): void {
  viewer.currentModelRoot?.updateMatrixWorld(true);
}

/**
 * Give `node` the world matrix `newWorld`, keeping the WORLD pose of every
 * direct child. One composite undo unit. Returns false when nothing changed
 * (no op is recorded then).
 */
async function retargetPivot(
  viewer: RVViewer,
  doc: AssetDocument,
  path: string,
  node: Object3D,
  newWorld: Matrix4,
  label: string,
): Promise<boolean> {
  const parentWorld = node.parent ? node.parent.matrixWorld : _m.identity();
  const nodeNext = decompose(new Matrix4().copy(parentWorld).invert().multiply(newWorld));
  const nodePrev = snapshotLocal(node);
  if (sameTransform(nodeNext, nodePrev)) return false;

  const newWorldInv = new Matrix4().copy(newWorld).invert();
  const childEdits: Array<{ path: string; next: NodeTransform; prev: NodeTransform }> = [];
  for (const child of node.children) {
    if (isRuntimeHelper(child)) continue;
    const next = decompose(new Matrix4().copy(newWorldInv).multiply(child.matrixWorld));
    const prev = snapshotLocal(child);
    if (!sameTransform(next, prev)) childEdits.push({ path: pathOf(viewer, child), next, prev });
  }

  await doc.withTransaction(label, async () => {
    doc.transformNode(path, nodeNext, nodePrev);
    for (const c of childEdits) doc.transformNode(c.path, c.next, c.prev);
  });
  await doc.whenIdle();
  return true;
}

// ─── Move the node ──────────────────────────────────────────────────────

/** Zero the LOCAL position of the given nodes. One undo unit. */
export async function zeroLocalPosition(
  viewer: RVViewer,
  doc: AssetDocument,
  paths: string[],
): Promise<void> {
  const edits: Array<{ path: string; prev: NodeTransform }> = [];
  for (const path of paths) {
    const node = movableNode(viewer, path);
    if (!node) continue;
    const prev = snapshotLocal(node);
    if (prev.position.every((c) => c === 0)) continue;
    edits.push({ path, prev });
  }
  if (edits.length === 0) return;
  const apply = (): void => {
    for (const e of edits) doc.transformNode(e.path, { ...e.prev, position: [0, 0, 0] }, e.prev);
  };
  if (edits.length === 1) apply();
  else await doc.withTransaction(`Zero local position of ${edits.length} objects`, async () => { apply(); });
  await doc.whenIdle();
}

/** Rotate a node by ±90° around one of its LOCAL axes. */
export function rotate90(
  viewer: RVViewer,
  doc: AssetDocument,
  path: string,
  axis: 'x' | 'y' | 'z',
  sign: 1 | -1 = 1,
): void {
  const node = movableNode(viewer, path);
  if (!node) return;
  const prev = snapshotLocal(node);
  _v.set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  // Local axis ⇒ post-multiply: the delta acts in the node's own frame.
  _q.fromArray(prev.quaternion).multiply(new Quaternion().setFromAxisAngle(_v, sign * Math.PI / 2));
  doc.transformNode(path, { ...prev, quaternion: _q.toArray() as [number, number, number, number] }, prev);
}

/** Drop a node so the bounding box of its subtree rests on world Y = 0. */
export function toGround(viewer: RVViewer, doc: AssetDocument, path: string): void {
  const node = movableNode(viewer, path);
  if (!node) return;
  refreshWorld(viewer);
  const box = worldBounds(node);
  if (!box) return;
  const dy = -box.min.y;
  if (Math.abs(dy) < EPS_POS) return;
  // World shift → the parent's local frame (linear part only, no translation).
  const shift = new Vector3(0, dy, 0);
  if (node.parent) {
    _m.copy(node.parent.matrixWorld).invert();
    shift.applyMatrix3(new Matrix3().setFromMatrix4(_m));
  }
  const prev = snapshotLocal(node);
  doc.transformNode(path, {
    ...prev,
    position: [prev.position[0] + shift.x, prev.position[1] + shift.y, prev.position[2] + shift.z],
  }, prev);
}

// ─── Move the pivot (children keep their world pose) ────────────────────

/** Pivot to the bottom-center of the node's subtree bounds. */
export async function pivotToBottom(viewer: RVViewer, doc: AssetDocument, path: string): Promise<void> {
  const node = movableNode(viewer, path);
  if (!node) return;
  refreshWorld(viewer);
  const box = worldBounds(node);
  if (!box) return;
  const target = new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const world = node.matrixWorld.clone().setPosition(target);
  await retargetPivot(viewer, doc, path, node, world, 'Pivot to bottom');
}

/** Pivot to the (vertex) center of another object — the target never moves. */
export async function pivotToObjectCenter(
  viewer: RVViewer,
  doc: AssetDocument,
  path: string,
  targetPath: string,
): Promise<void> {
  const node = movableNode(viewer, path);
  const target = viewer.registry?.getNode(targetPath) ?? null;
  if (!node || !target) return;
  refreshWorld(viewer);
  const center = worldVertexCenter(target);
  if (!center) return;
  const world = node.matrixWorld.clone().setPosition(center);
  await retargetPivot(viewer, doc, path, node, world, 'Pivot to object center');
}

/** Rotate the node (about its own origin) so its local +Y points at world up. */
export async function alignYUp(viewer: RVViewer, doc: AssetDocument, path: string): Promise<void> {
  const node = movableNode(viewer, path);
  if (!node) return;
  refreshWorld(viewer);
  const up = new Vector3(0, 1, 0);
  const worldQuat = node.getWorldQuaternion(new Quaternion());
  const currentUp = new Vector3(0, 1, 0).applyQuaternion(worldQuat).normalize();
  const delta = new Quaternion().setFromUnitVectors(currentUp, up);
  const origin = new Vector3().setFromMatrixPosition(node.matrixWorld);
  const world = node.matrixWorld.clone().premultiply(new Matrix4().makeRotationFromQuaternion(delta));
  world.setPosition(origin);
  await retargetPivot(viewer, doc, path, node, world, 'Align Y up');
}

/** Name of the group the node's (first) Kinematic component references, or null. */
export function getKinematicGroupName(node: Object3D): string | null {
  return kinematicGroupNamesOf(node)[0] ?? null;
}

/** How many nodes currently belong to the group the kinematic `node` drives. */
export function kinematicGroupMemberCount(viewer: RVViewer, node: Object3D): number {
  const name = getKinematicGroupName(node);
  return name ? viewer.groups?.get(name)?.nodes.length ?? 0 : 0;
}

/** Move a kinematic axis' pivot to the world center of its group's members. */
export async function centerKinematicToGroup(
  viewer: RVViewer,
  doc: AssetDocument,
  kinPath: string,
): Promise<void> {
  const node = movableNode(viewer, kinPath);
  if (!node) return;
  const groupName = getKinematicGroupName(node);
  const members = groupName ? viewer.groups?.get(groupName)?.nodes ?? [] : [];
  if (members.length === 0) return;
  refreshWorld(viewer);
  const union = new Box3();
  for (const member of members) {
    const box = worldBounds(member);
    if (box) union.union(box);
  }
  if (union.isEmpty()) return;
  const world = node.matrixWorld.clone().setPosition(union.getCenter(new Vector3()));
  await retargetPivot(viewer, doc, kinPath, node, world, 'Center pivot to group');
}

/**
 * Put the pivot on a circle (a bore, a boss) found on `mesh`: the node lands on
 * the circle's centre with its local +Y on the circle's axis.
 *
 * `centerLocal` / `axisLocal` are in the MESH's local frame and are carried to
 * world space from the mesh's CURRENT matrixWorld — a snapshot taken at hover
 * time would be stale after any jog, undo or re-import in between. Of the two
 * axis signs the one nearer the node's current world +Y wins (no silent 180°
 * flip), and the correction is a shortest arc so the roll about the new axis
 * survives. Refuses a missing node/mesh and a zero axis (a NaN quaternion would
 * poison every matrix below it).
 */
export async function pivotToCircle(
  viewer: RVViewer,
  doc: AssetDocument,
  path: string,
  mesh: Object3D | null | undefined,
  centerLocal: Vector3,
  axisLocal: Vector3,
): Promise<void> {
  const node = movableNode(viewer, path);
  if (!node || !mesh) return;
  if (axisLocal.lengthSq() < 1e-18) return;
  refreshWorld(viewer);
  mesh.updateWorldMatrix(true, false);

  const center = centerLocal.clone().applyMatrix4(mesh.matrixWorld);
  const meshQuat = mesh.getWorldQuaternion(new Quaternion());
  const axis = axisLocal.clone().normalize().applyQuaternion(meshQuat).normalize();

  const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
  node.matrixWorld.decompose(p, q, s);
  const currentUp = new Vector3(0, 1, 0).applyQuaternion(q).normalize();
  if (axis.dot(currentUp) < 0) axis.negate();

  const delta = new Quaternion().setFromUnitVectors(currentUp, axis);
  const world = new Matrix4().compose(center, delta.multiply(q), s);
  await retargetPivot(viewer, doc, path, node, world, 'Pivot to circle');
}
