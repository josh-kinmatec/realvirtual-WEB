// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * select-actions — the set computations behind "Select ▸ Identical / Material /
 * Invert". Pure functions over a `path → Mesh` universe map: no viewer, no
 * document, no scene mutation.
 *
 * ## Geometry identity (`geometrySignature` / `signaturesMatch`)
 *
 * Two CAD occurrences of the same part rarely share a `BufferGeometry`: every
 * occurrence is tessellated on its own, baked into its own placement, and often
 * emitted with a different vertex order. The signature therefore uses only
 * quantities that survive that:
 *
 *  - rigid motion and mirroring — distances from the vertex centroid, the
 *    eigenvalues of the vertex covariance, surface area and |volume|;
 *  - vertex ORDER — everything is sorted/summed;
 *  - float noise — comparison is tolerance-based, never exact;
 *  - extra attributes (uber-bake colour/rmPacked) — only `position` is read.
 *
 * and keeps what must tell parts apart: the vertex count and triangle count
 * (different tessellation density is intentionally NOT "identical") plus size.
 * `signaturesMatch` is a necessary-condition test on these invariants, not a
 * proof of congruence — two different parts with equal invariants would match.
 * That is accepted: the feature selects candidates for a human to confirm.
 */

import { Matrix3, Vector3 } from 'three';
import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute, Material, Mesh, Object3D } from 'three';
import { materialToValue, materialValueKey } from '../../core/editor/rv-asset-material';

type PositionAttribute = BufferAttribute | InterleavedBufferAttribute;

/** `path -> mesh` map of the selectable scene. Typed with `Object3D` values
 *  because that is what the scene scan produces; every entry is a mesh. */
export type MeshUniverse = ReadonlyMap<string, Object3D>;

const asMesh = (o: Object3D | undefined): Mesh | undefined => o as Mesh | undefined;

// ─── Universe expansion ─────────────────────────────────────────────────

/**
 * Expand paths to the universe meshes they stand for: a path that IS a universe
 * mesh stays as itself, a group path stands for every universe mesh below it.
 * Segment-aware — `A` does not match `AB/box`.
 */
export function expandToUniverseMeshes(
  universe: MeshUniverse,
  paths: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  const roots = [...paths];
  if (roots.length === 0) return out;
  for (const root of roots) if (universe.has(root)) out.add(root);
  const prefixes = roots.map((p) => `${p}/`);
  for (const key of universe.keys()) {
    if (out.has(key)) continue;
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) { out.add(key); break; }
    }
  }
  return out;
}

/** The seeds a Select action starts from: the whole selection when the clicked
 *  node is part of it, otherwise just the clicked node. */
export function resolveSeedPaths(selection: readonly string[], clicked: string): string[] {
  return selection.includes(clicked) ? [...selection] : [clicked];
}

// ─── Geometry signature ─────────────────────────────────────────────────

/** Number of rank-sampled centroid distances kept per signature. */
const RADIAL_SAMPLES = 64;
/** Absolute floor of the distance tolerance (scene units — metres): float32
 *  noise of a baked placement at a few metres from the origin is ~1e-6. */
const TOL_ABS = 2e-5;
/** Relative distance tolerance, of the largest centroid distance. */
const TOL_REL = 1e-4;
/** Relative tolerance of the covariance eigenvalues and of area / volume. */
const TOL_SHAPE = 1e-3;

/** Pose- and order-invariant fingerprint of a geometry. */
export interface GeometrySignature {
  vertexCount: number;
  triangleCount: number;
  /** Largest vertex distance from the centroid. */
  radius: number;
  /** Rank-sampled sorted centroid distances (ascending). */
  radial: number[];
  /** Eigenvalues of the vertex covariance (ascending). */
  eigen: [number, number, number];
  /** Total triangle area. */
  area: number;
  /** |signed volume| (meaningful for closed meshes; invariant either way). */
  volume: number;
}

const signatureCache = new WeakMap<BufferGeometry, GeometrySignature>();

/** Eigenvalues of a symmetric 3×3 matrix, ascending (analytic, Smith 1961). */
function symmetricEigenvalues(m: Matrix3): [number, number, number] {
  const e = m.elements; // column-major, symmetric
  const a11 = e[0], a22 = e[4], a33 = e[8];
  const a12 = e[3], a13 = e[6], a23 = e[7];
  const p1 = a12 * a12 + a13 * a13 + a23 * a23;
  if (p1 < 1e-30) return [a11, a22, a33].sort((x, y) => x - y) as [number, number, number];
  const q = (a11 + a22 + a33) / 3;
  const p2 = (a11 - q) ** 2 + (a22 - q) ** 2 + (a33 - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b11 = (a11 - q) / p, b22 = (a22 - q) / p, b33 = (a33 - q) / p;
  const b12 = a12 / p, b13 = a13 / p, b23 = a23 / p;
  const detB = b11 * (b22 * b33 - b23 * b23) - b12 * (b12 * b33 - b23 * b13) + b13 * (b12 * b23 - b22 * b13);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const l1 = q + 2 * p * Math.cos(phi);
  const l3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const l2 = 3 * q - l1 - l3;
  return [l3, l2, l1];
}

/**
 * Compute the invariant signature of a geometry (cached per geometry object).
 * Geometries without a position attribute yield an empty signature that matches
 * only other empty ones.
 */
export function geometrySignature(geometry: BufferGeometry): GeometrySignature {
  const cached = signatureCache.get(geometry);
  if (cached) return cached;

  const pos = geometry.getAttribute('position') as PositionAttribute | undefined;
  const n = pos?.count ?? 0;
  if (!pos || n === 0) {
    const empty: GeometrySignature = {
      vertexCount: 0, triangleCount: 0, radius: 0, radial: [], eigen: [0, 0, 0], area: 0, volume: 0,
    };
    signatureCache.set(geometry, empty);
    return empty;
  }

  // Centroid, in doubles.
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i); }
  cx /= n; cy /= n; cz /= n;

  // Centered distances + covariance.
  const dist = new Float64Array(n);
  let sxx = 0, syy = 0, szz = 0, sxy = 0, sxz = 0, syz = 0;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i) - cx, y = pos.getY(i) - cy, z = pos.getZ(i) - cz;
    dist[i] = Math.sqrt(x * x + y * y + z * z);
    sxx += x * x; syy += y * y; szz += z * z; sxy += x * y; sxz += x * z; syz += y * z;
  }
  const cov = new Matrix3().set(sxx / n, sxy / n, sxz / n, sxy / n, syy / n, syz / n, sxz / n, syz / n, szz / n);
  const eigen = symmetricEigenvalues(cov);

  dist.sort();
  const radial: number[] = [];
  const samples = Math.min(RADIAL_SAMPLES, n);
  for (let k = 0; k < samples; k++) {
    radial.push(dist[samples === 1 ? 0 : Math.round((k * (n - 1)) / (samples - 1))]);
  }

  // Area and volume over the triangles (indexed or sequential triples).
  const index = geometry.getIndex();
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(n / 3);
  let area = 0, volume = 0;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  const ab = new Vector3(), ac = new Vector3();
  for (let t = 0; t < triangleCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.set(pos.getX(i0) - cx, pos.getY(i0) - cy, pos.getZ(i0) - cz);
    b.set(pos.getX(i1) - cx, pos.getY(i1) - cy, pos.getZ(i1) - cz);
    c.set(pos.getX(i2) - cx, pos.getY(i2) - cy, pos.getZ(i2) - cz);
    ab.subVectors(b, a); ac.subVectors(c, a);
    area += ab.cross(ac).length() / 2;
    volume += a.dot(b.clone().cross(c)) / 6;
  }

  const sig: GeometrySignature = {
    vertexCount: n, triangleCount, radius: dist[n - 1], radial, eigen, area, volume: Math.abs(volume),
  };
  signatureCache.set(geometry, sig);
  return sig;
}

function close(x: number, y: number, tol: number): boolean {
  return Math.abs(x - y) <= tol;
}

/** Do two signatures describe the same shape (see the module header)? */
export function signaturesMatch(a: GeometrySignature, b: GeometrySignature): boolean {
  if (a === b) return true;
  if (a.vertexCount !== b.vertexCount || a.triangleCount !== b.triangleCount) return false;
  if (a.vertexCount === 0) return true;
  const scale = Math.max(a.radius, b.radius);
  const tol = Math.max(TOL_ABS, TOL_REL * scale);
  if (!close(a.radius, b.radius, tol)) return false;
  for (let i = 0; i < a.radial.length; i++) {
    if (!close(a.radial[i], b.radial[i], tol)) return false;
  }
  const eigenScale = Math.max(a.eigen[2], b.eigen[2], 1e-12);
  for (let i = 0; i < 3; i++) {
    if (!close(a.eigen[i], b.eigen[i], TOL_SHAPE * eigenScale + 1e-12)) return false;
  }
  const areaScale = Math.max(a.area, b.area, 1e-12);
  if (!close(a.area, b.area, TOL_SHAPE * areaScale)) return false;
  const volScale = Math.max(a.volume, b.volume, 1e-12);
  return close(a.volume, b.volume, TOL_SHAPE * volScale + 1e-12);
}

// ─── Select sets ────────────────────────────────────────────────────────

/**
 * Every universe mesh whose geometry matches a seed's — material ignored. A
 * shared geometry reference is a match without computing anything; others are
 * compared by signature (cached per geometry). Result order = universe order.
 */
export function computeIdenticalPaths(
  universe: MeshUniverse,
  seeds: ReadonlySet<string>,
): string[] {
  const seedGeometries = new Set<BufferGeometry>();
  for (const path of seeds) {
    const mesh = asMesh(universe.get(path));
    if (mesh?.geometry) seedGeometries.add(mesh.geometry);
  }
  if (seedGeometries.size === 0) return [];

  const seedSignatures = [...seedGeometries].map(geometrySignature);
  const out: string[] = [];
  for (const [path, object] of universe) {
    const geometry = asMesh(object)?.geometry;
    if (!geometry) continue;
    if (seedGeometries.has(geometry)) { out.push(path); continue; }
    const sig = geometrySignature(geometry);
    if (seedSignatures.some((s) => signaturesMatch(s, sig))) out.push(path);
  }
  return out;
}

/** Appearance fingerprint of a material: equal for equal-looking materials. */
function materialFingerprint(mat: Material): string {
  const value = materialToValue(mat);
  if (value) return `flat|${materialValueKey(value)}`;
  // Textured / non-standard: identity of the maps is part of the look.
  const m = mat as Material & Record<string, unknown>;
  const color = (m['color'] as { getHexString?: () => string } | undefined)?.getHexString?.() ?? '-';
  const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']
    .map((k) => (m[k] as { uuid?: string } | null | undefined)?.uuid ?? '-')
    .join(',');
  return `${mat.type}|${color}|${mat.opacity}|${mat.transparent}|${maps}`;
}

function fingerprintsOf(mesh: Mesh): string[] {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.filter(Boolean).map(materialFingerprint);
}

/**
 * Every universe mesh wearing a seed's appearance — compared by fingerprint, not
 * by reference, and across ANY slot of a multi-material mesh. Result order =
 * universe order.
 */
export function computeSameMaterialPaths(
  universe: MeshUniverse,
  seeds: ReadonlySet<string>,
): string[] {
  const wanted = new Set<string>();
  for (const path of seeds) {
    const mesh = asMesh(universe.get(path));
    if (mesh) for (const f of fingerprintsOf(mesh)) wanted.add(f);
  }
  if (wanted.size === 0) return [];
  const out: string[] = [];
  for (const [path, object] of universe) {
    if (fingerprintsOf(object as Mesh).some((f) => wanted.has(f))) out.push(path);
  }
  return out;
}

/** The complement of the selection within the universe (group paths expanded).
 *  With nothing selected that is everything — "Select All". */
export function computeInvertPaths(
  universe: MeshUniverse,
  selection: readonly string[],
): string[] {
  const selected = expandToUniverseMeshes(universe, selection);
  const out: string[] = [];
  for (const path of universe.keys()) if (!selected.has(path)) out.push(path);
  return out;
}
