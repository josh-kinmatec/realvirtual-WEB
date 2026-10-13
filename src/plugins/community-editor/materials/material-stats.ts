// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * materials/material-stats — material and texture health of an asset.
 *
 * Counts materials / meshes / textures and raises actionable warnings: duplicate
 * materials (distinct instances that render identically), non-power-of-two and
 * oversized (≥ 2048 px) textures, and transparency flags with no visual effect.
 * Each warning carries the mesh paths it refers to so a caller can select them.
 *
 * Deliberately no triangle / draw-call statistics — those live in the dev tools.
 * Pure read of the scene graph; runtime helper subtrees (`_`-prefixed names,
 * gizmos) are skipped.
 */

import type { Material, Mesh, Object3D, Texture } from 'three';
import { materialToValue, materialValueKey } from '../../../core/editor/rv-asset-material';
import { NodeRegistry } from '../../../core/engine/rv-node-registry';

/** Textures at or above this edge length are flagged as oversized. */
const OVERSIZED_TEXTURE_PX = 2048;

const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap',
  'lightMap', 'bumpMap', 'displacementMap', 'envMap',
] as const;

/** One health finding, with the meshes it concerns. */
export interface MaterialWarning {
  /** Stable id: `duplicate-materials`, `npot-textures`, `oversized-textures`, `pointless-transparency`. */
  id: string;
  label: string;
  meshPaths: string[];
}

/** Summary of an asset's materials. */
export interface MaterialStats {
  materialCount: number;
  /** Distinct appearances — equals `materialCount` when nothing is duplicated. */
  uniqueByAppearance: number;
  meshCount: number;
  textureCount: number;
  /** Rough GPU size of all textures (RGBA8 + mip chain); 0 when sizes are unknown. */
  textureBytes: number;
  warnings: MaterialWarning[];
}

function emptyStats(): MaterialStats {
  return { materialCount: 0, uniqueByAppearance: 0, meshCount: 0, textureCount: 0, textureBytes: 0, warnings: [] };
}

function isRuntimeHelper(node: Object3D): boolean {
  return node.name.startsWith('_') || node.userData?._rvGizmo === true;
}

function collectMeshes(node: Object3D, out: Mesh[]): void {
  if (isRuntimeHelper(node)) return;
  const mesh = node as Mesh;
  if (mesh.isMesh && mesh.material) out.push(mesh);
  for (const child of node.children) collectMeshes(child, out);
}

function materialsOf(mesh: Mesh): Material[] {
  return (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean);
}

/** Appearance identity: flat materials by value, textured ones by their maps. */
function appearanceKey(mat: Material): string {
  const value = materialToValue(mat);
  if (value) return `flat|${materialValueKey(value)}`;
  const m = mat as Material & Record<string, unknown>;
  const maps = TEXTURE_SLOTS.map((k) => (m[k] as Texture | null | undefined)?.uuid ?? '-').join(',');
  const color = (m['color'] as { getHexString?: () => string } | undefined)?.getHexString?.() ?? '-';
  return `${mat.type}|${color}|${mat.opacity}|${mat.transparent}|${maps}`;
}

function textureSize(tex: Texture): { w: number; h: number } | null {
  const img = tex.image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | null | undefined;
  const w = img?.naturalWidth ?? img?.width;
  const h = img?.naturalHeight ?? img?.height;
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

const isPow2 = (n: number): boolean => (n & (n - 1)) === 0;

/** Compute the material health summary of the asset under `root`. */
export function computeMaterialStats(root: Object3D | null | undefined): MaterialStats {
  const stats = emptyStats();
  if (!root) return stats;

  const meshes: Mesh[] = [];
  collectMeshes(root, meshes);
  stats.meshCount = meshes.length;

  const materials = new Set<Material>();
  const meshesByMaterial = new Map<Material, Mesh[]>();
  for (const mesh of meshes) {
    for (const mat of materialsOf(mesh)) {
      materials.add(mat);
      const list = meshesByMaterial.get(mat);
      if (list) { if (!list.includes(mesh)) list.push(mesh); } else meshesByMaterial.set(mat, [mesh]);
    }
  }
  stats.materialCount = materials.size;

  const pathOf = (mesh: Mesh): string => NodeRegistry.computeNodePath(mesh);
  const pathsOf = (set: Iterable<Mesh>): string[] => [...new Set(set)].map(pathOf);

  // Duplicates: distinct instances sharing one appearance.
  const byAppearance = new Map<string, Material[]>();
  for (const mat of materials) {
    const key = appearanceKey(mat);
    const list = byAppearance.get(key);
    if (list) list.push(mat); else byAppearance.set(key, [mat]);
  }
  stats.uniqueByAppearance = byAppearance.size;
  let duplicates = 0;
  const duplicateMeshes = new Set<Mesh>();
  for (const group of byAppearance.values()) {
    if (group.length < 2) continue;
    duplicates += group.length - 1;
    for (const mat of group) for (const mesh of meshesByMaterial.get(mat) ?? []) duplicateMeshes.add(mesh);
  }
  if (duplicates > 0) {
    stats.warnings.push({
      id: 'duplicate-materials',
      label: `${duplicates} duplicate material${duplicates === 1 ? '' : 's'} (identical appearance)`,
      meshPaths: pathsOf(duplicateMeshes),
    });
  }

  // Textures.
  const textures = new Map<Texture, Mesh[]>();
  for (const mat of materials) {
    const m = mat as Material & Record<string, unknown>;
    for (const slot of TEXTURE_SLOTS) {
      const tex = m[slot] as Texture | null | undefined;
      if (!tex || !(tex as { isTexture?: boolean }).isTexture) continue;
      const list = textures.get(tex) ?? [];
      for (const mesh of meshesByMaterial.get(mat) ?? []) if (!list.includes(mesh)) list.push(mesh);
      textures.set(tex, list);
    }
  }
  stats.textureCount = textures.size;

  const npotMeshes = new Set<Mesh>();
  const bigMeshes = new Set<Mesh>();
  let npot = 0, oversized = 0;
  for (const [tex, owners] of textures) {
    const size = textureSize(tex);
    if (!size) continue;
    stats.textureBytes += Math.round(size.w * size.h * 4 * 1.33);
    if (!isPow2(size.w) || !isPow2(size.h)) { npot++; for (const m of owners) npotMeshes.add(m); }
    if (Math.max(size.w, size.h) >= OVERSIZED_TEXTURE_PX) { oversized++; for (const m of owners) bigMeshes.add(m); }
  }
  if (npot > 0) {
    stats.warnings.push({
      id: 'npot-textures',
      label: `${npot} non-power-of-two texture${npot === 1 ? '' : 's'}`,
      meshPaths: pathsOf(npotMeshes),
    });
  }
  if (oversized > 0) {
    stats.warnings.push({
      id: 'oversized-textures',
      label: `${oversized} oversized texture${oversized === 1 ? '' : 's'} (≥ ${OVERSIZED_TEXTURE_PX}px)`,
      meshPaths: pathsOf(bigMeshes),
    });
  }

  // Transparency flag on a fully opaque material renders but sorts for nothing.
  const pointless = new Set<Mesh>();
  let pointlessMaterials = 0;
  for (const mat of materials) {
    const m = mat as Material & { alphaMap?: Texture | null };
    if (mat.transparent && mat.opacity >= 1 && !m.alphaMap) {
      pointlessMaterials++;
      for (const mesh of meshesByMaterial.get(mat) ?? []) pointless.add(mesh);
    }
  }
  if (pointlessMaterials > 0) {
    stats.warnings.push({
      id: 'pointless-transparency',
      label: `${pointlessMaterials} material${pointlessMaterials === 1 ? '' : 's'} flagged transparent but fully opaque`,
      meshPaths: pathsOf(pointless),
    });
  }

  return stats;
}

/** Human-readable byte size: `512 B`, `2 KB`, `5.0 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
