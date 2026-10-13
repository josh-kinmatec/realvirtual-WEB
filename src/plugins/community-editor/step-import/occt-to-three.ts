// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * occt-to-three — turn an `occt-import-js` result into a Three.js tree.
 *
 * Pure (Three.js only; no DOM, no WASM, no storage), so it runs unchanged in the
 * conversion worker and in tests on the main thread.
 *
 * What `occt-import-js` hands us (README + js-interface.cpp of the package):
 *   - `root` / `children`: a NAME hierarchy of the STEP assembly. Only leaf nodes
 *     (parts) carry `meshes`; the root is unnamed.
 *   - Vertices are already in ASSEMBLY (world) coordinates — each instance's
 *     placement is baked into its mesh by OCCT, so every node of the tree we build
 *     keeps an identity transform and the structure is preserved by name only.
 *   - One mesh per solid / free shell. Colour may sit on the mesh and/or per
 *     B-Rep face (`brep_faces`, contiguous triangle ranges).
 *   - Units are whatever `linearUnit` asked for. We ask for millimetres and apply
 *     the mm -> m factor on the content root ({@link normalizeStepRoot}) so the
 *     node transform records the normalisation, as `CADLinkExtras.ImportScaleFactor`
 *     and `ZIsUpVector` state.
 *
 * Colour handling: a mesh whose faces all share one colour gets one shared
 * material per colour. A mesh with differing face colours gets the colours baked
 * into a normalized-Uint8 `COLOR_0` attribute and one shared white `vertexColors`
 * material — no geometry groups, so it exports as a single glTF primitive. This is
 * the shape `tests/rv-cad-glb-roundtrip.test.ts` specifies.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
  Uint8BufferAttribute,
} from 'three';

/** mm -> m (matches `CADLinkExtras.ImportScaleFactor`, "Always 0.001 today"). */
export const STEP_MM_TO_M = 0.001;

/**
 * Colour space note: OCCT (>= 7.7, which occt-import-js 0.0.23 embeds) reports colours as
 * LINEAR RGB (a STEP `COLOUR_RGB` of 0.6 comes back as ~0.3185). glTF base colours and
 * `COLOR_0` are linear as well, so values are passed through unchanged — no conversion.
 * (Observed in `tests/step-import-core.test.ts`; not documented by the package README.)
 *
 * Grey used for geometry without any colour in the STEP file: sRGB 0.7, expressed in the
 * linear space everything else here is in.
 */
const DEFAULT_COLOR: readonly [number, number, number] = (() => {
  const c = new Color().setRGB(0.7, 0.7, 0.7, SRGBColorSpace);
  return [c.r, c.g, c.b] as const;
})();

// ─── occt-import-js result shapes (structural, so tests need no WASM) ───

export interface OcctFaceData {
  /** First triangle index of the face (inclusive). */
  first: number;
  /** Last triangle index of the face (inclusive; `first - 1` for an empty face). */
  last: number;
  color?: number[] | null;
}

export interface OcctMeshData {
  name: string;
  /** Mesh (solid) colour, 0..1 RGB. Absent when the STEP file carries none. */
  color?: number[];
  brep_faces: OcctFaceData[];
  attributes: {
    position: { array: ArrayLike<number> };
    normal?: { array: ArrayLike<number> };
  };
  index: { array: ArrayLike<number> };
}

export interface OcctNodeData {
  name: string;
  /** Indices into {@link OcctResultData.meshes}. */
  meshes: number[];
  children: OcctNodeData[];
}

export interface OcctResultData {
  success: boolean;
  root?: OcctNodeData;
  meshes?: OcctMeshData[];
}

// ─── Materials ──────────────────────────────────────────────────────────

/**
 * Per-conversion material pool. Materials are shared by colour so the exported
 * GLB carries one glTF material per distinct colour instead of one per solid —
 * and so a re-import keeps working when two files use the same palette.
 */
export class StepMaterialCache {
  private readonly _solid = new Map<string, MeshStandardMaterial>();
  private _vertexColor: MeshStandardMaterial | null = null;

  /** Shared material for a uniform colour (`null` → the default grey). */
  solid(color: readonly number[] | null | undefined): MeshStandardMaterial {
    const rgb = color && color.length >= 3 ? color : DEFAULT_COLOR;
    const key = `${to8(rgb[0])}-${to8(rgb[1])}-${to8(rgb[2])}`;
    let material = this._solid.get(key);
    if (!material) {
      material = new MeshStandardMaterial({
        color: new Color(rgb[0], rgb[1], rgb[2]),
        roughness: 0.6,
        metalness: 0,
      });
      material.name = `STEP_${hex8(rgb[0])}${hex8(rgb[1])}${hex8(rgb[2])}`;
      this._solid.set(key, material);
    }
    return material;
  }

  /** The single shared white material that multiplies by the `COLOR_0` attribute. */
  vertexColor(): MeshStandardMaterial {
    if (!this._vertexColor) {
      this._vertexColor = new MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.6,
        metalness: 0,
        vertexColors: true,
      });
      this._vertexColor.name = 'STEP_VertexColor';
    }
    return this._vertexColor;
  }

  /** Release GPU-free resources (materials hold none, but keep the contract explicit). */
  dispose(): void {
    for (const m of this._solid.values()) m.dispose();
    this._solid.clear();
    this._vertexColor?.dispose();
    this._vertexColor = null;
  }
}

function to8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function hex8(v: number): string {
  return to8(v).toString(16).padStart(2, '0');
}

// ─── Mesh ───────────────────────────────────────────────────────────────

/** Number of triangles in an OCCT mesh. */
export function occtTriangleCount(data: OcctMeshData): number {
  return Math.floor(data.index.array.length / 3);
}

/**
 * Build one Three.js mesh from an OCCT mesh (one solid / shell).
 *
 * `materials` is optional; without it every call mints its own materials.
 */
export function buildMesh(data: OcctMeshData, materials: StepMaterialCache = new StepMaterialCache()): Mesh {
  const positions = Float32Array.from(data.attributes.position.array);
  const vertexCount = Math.floor(positions.length / 3);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));

  const indexSource = data.index.array;
  const index = vertexCount > 65535 ? new Uint32Array(indexSource.length) : new Uint16Array(indexSource.length);
  for (let i = 0; i < indexSource.length; i++) index[i] = indexSource[i];
  geometry.setIndex(new BufferAttribute(index, 1));

  const normals = data.attributes.normal?.array;
  if (normals && normals.length === positions.length) {
    geometry.setAttribute('normal', new Float32BufferAttribute(Float32Array.from(normals), 3));
  } else {
    geometry.computeVertexNormals();
  }

  const material = assignColors(geometry, data, vertexCount, materials);
  const mesh = new Mesh(geometry, material);
  mesh.name = data.name;
  return mesh;
}

/** Effective colour of a face: its own, else the mesh's, else none. */
function faceColor(face: OcctFaceData, data: OcctMeshData): readonly number[] | null {
  if (face.color && face.color.length >= 3) return face.color;
  if (data.color && data.color.length >= 3) return data.color;
  return null;
}

function sameColor(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return to8(a[0]) === to8(b[0]) && to8(a[1]) === to8(b[1]) && to8(a[2]) === to8(b[2]);
}

/**
 * Uniform colour → shared solid material. Differing face colours → bake them
 * into `COLOR_0` and return the shared vertex-colour material.
 *
 * Each B-Rep face owns a private vertex block in the OCCT output (vertices are
 * not shared between faces), so a face's colour is painted onto the vertices its
 * triangles reference.
 */
function assignColors(
  geometry: BufferGeometry,
  data: OcctMeshData,
  vertexCount: number,
  materials: StepMaterialCache,
): MeshStandardMaterial {
  const faces = data.brep_faces ?? [];
  const meshColor = data.color && data.color.length >= 3 ? data.color : null;
  if (faces.length === 0) return materials.solid(meshColor);

  const first = faceColor(faces[0], data);
  if (faces.every((f) => sameColor(faceColor(f, data), first))) return materials.solid(first);

  // RGBA rather than RGB: glTF requires 4-byte aligned vertex elements, and a
  // 3 x Uint8 colour is not. Alpha stays 255 (opaque).
  const colors = new Uint8Array(vertexCount * 4);
  const fallback = meshColor ?? DEFAULT_COLOR;
  // Pre-fill with the mesh/default colour so a vertex no face range references
  // (cannot happen with OCCT output, but is cheap to be safe about) is not black.
  for (let v = 0; v < vertexCount; v++) {
    colors[v * 4] = to8(fallback[0]);
    colors[v * 4 + 1] = to8(fallback[1]);
    colors[v * 4 + 2] = to8(fallback[2]);
    colors[v * 4 + 3] = 255;
  }
  const index = geometry.getIndex()!;
  for (const face of faces) {
    const rgb = faceColor(face, data) ?? fallback;
    const r = to8(rgb[0]);
    const g = to8(rgb[1]);
    const b = to8(rgb[2]);
    for (let t = face.first; t <= face.last; t++) {
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        colors[v * 4] = r;
        colors[v * 4 + 1] = g;
        colors[v * 4 + 2] = b;
      }
    }
  }
  geometry.setAttribute('color', new Uint8BufferAttribute(colors, 4, true));
  return materials.vertexColor();
}

// ─── Hierarchy ──────────────────────────────────────────────────────────

export interface BuildHierarchyOptions {
  /** Name of the content root (default `'STEP'`). */
  rootName?: string;
  materials?: StepMaterialCache;
}

export interface BuiltHierarchy {
  root: Group;
  /** Mesh count actually placed in the tree (zero-triangle bodies are skipped). */
  meshCount: number;
  triangleCount: number;
  nodeCount: number;
}

/**
 * Build the content tree. Shape rules:
 *  - the content root is a Group named `rootName`; the OCCT top-level nodes are its children;
 *  - a part with exactly one solid IS that mesh (named after the part) — one mesh per part,
 *    no extra wrapper level;
 *  - a part with several solids is a Group (named after the part) holding one mesh per solid,
 *    named after the solid, else `<part>_<n>`;
 *  - an unnamed node is called `Part` (leaf) / `Assembly` (has children).
 * Names are NOT deduplicated here: sibling dedup is the document's job
 * (`dedupeSiblingNames` in the core), and the GLB round trip dedups globally.
 */
export function buildHierarchy(result: OcctResultData, options: BuildHierarchyOptions = {}): BuiltHierarchy {
  const materials = options.materials ?? new StepMaterialCache();
  const meshes = result.meshes ?? [];
  const stats = { meshCount: 0, triangleCount: 0, nodeCount: 0 };

  const root = new Group();
  root.name = options.rootName?.trim() || 'STEP';
  stats.nodeCount++;

  const addMesh = (data: OcctMeshData, fallbackName: string): Mesh | null => {
    const triangles = occtTriangleCount(data);
    if (triangles === 0 || data.attributes.position.array.length === 0) return null;
    const mesh = buildMesh(data, materials);
    if (!mesh.name) mesh.name = fallbackName;
    stats.meshCount++;
    stats.triangleCount += triangles;
    stats.nodeCount++;
    return mesh;
  };

  const buildNode = (node: OcctNodeData): Object3D | null => {
    const children = node.children ?? [];
    const baseName = node.name?.trim() || (children.length > 0 ? 'Assembly' : 'Part');
    const partMeshes: Mesh[] = [];
    const meshIndices = node.meshes ?? [];
    for (let i = 0; i < meshIndices.length; i++) {
      const data = meshes[meshIndices[i]];
      if (!data) continue;
      const mesh = addMesh(data, meshIndices.length > 1 ? `${baseName}_${i + 1}` : baseName);
      if (mesh) partMeshes.push(mesh);
    }

    const childNodes: Object3D[] = [];
    for (const child of children) {
      const built = buildNode(child);
      if (built) childNodes.push(built);
    }

    if (partMeshes.length === 1 && childNodes.length === 0) {
      // One solid, no sub-structure: the part IS the mesh.
      partMeshes[0].name = baseName;
      return partMeshes[0];
    }
    if (partMeshes.length === 0 && childNodes.length === 0) return null; // empty part: nothing to show

    const group = new Group();
    group.name = baseName;
    stats.nodeCount++;
    for (const m of partMeshes) group.add(m);
    for (const c of childNodes) group.add(c);
    return group;
  };

  for (const top of result.root?.children ?? []) {
    const built = buildNode(top);
    if (built) root.add(built);
  }
  // A root that itself carries meshes (not produced by occt-import-js 0.0.23, but
  // cheap to honour): attach them directly.
  for (const i of result.root?.meshes ?? []) {
    const data = meshes[i];
    const mesh = data ? addMesh(data, 'Part') : null;
    if (mesh) root.add(mesh);
  }

  // The GLB loader de-duplicates names file-wide (`_1` suffix), and it would hand the suffix
  // to the PART when the content root carries the same name — a single-part file `bolt.stp`
  // with product "bolt" would come back as `bolt` > `bolt_1`. The root name is overwritten by
  // `importCad` anyway (it takes the asset-unique name), so make it collision-free here.
  const taken = new Set<string>();
  root.traverse((n) => { if (n !== root) taken.add(n.name); });
  while (taken.has(root.name)) root.name = `${root.name}_root`;

  return { root, ...stats };
}

// ─── Normalisation ──────────────────────────────────────────────────────

/**
 * Apply the import normalisation to the content root: mm -> m (uniform scale
 * 0.001) and Z-up -> Y-up (rotation -90° about X, which maps (x, y, z) to
 * (x, z, -y)). The factors live on the ROOT TRANSFORM — children keep identity —
 * which is what `CADLinkExtras.ImportScaleFactor` / `ZIsUpVector` describe and
 * what a CADLink re-import copies from the old root onto the new one.
 *
 * Mutates and returns `root`.
 */
export function normalizeStepRoot<T extends Object3D>(root: T): T {
  root.scale.setScalar(STEP_MM_TO_M);
  root.rotation.set(-Math.PI / 2, 0, 0);
  root.updateMatrix();
  return root;
}
