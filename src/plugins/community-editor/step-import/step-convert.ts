// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-convert — the conversion core: STEP bytes -> GLB bytes.
 *
 * Takes an already-initialised `occt-import-js` module, so the very same function
 * runs inside the conversion worker (`step-import-worker.ts`, a thin wrapper) and on
 * the main thread in tests / the no-Worker fallback. It touches no storage and no DOM.
 *
 * Pipeline: `ReadStepFile` (OCCT tessellation, the slow, uninterruptible part) ->
 * {@link buildHierarchy} -> {@link normalizeStepRoot} (mm -> m, Z-up -> Y-up on the
 * root) -> GLTFExporter (binary) -> {@link assertGlbMeshCount}.
 */

import type { Object3D, Mesh } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { OcctModule } from 'occt-import-js';
import { assertGlbMeshCount } from '../../../core/import/rv-glb-inspect';
import { buildHierarchy, normalizeStepRoot, StepMaterialCache } from './occt-to-three';
import { stepTessellationParams } from './step-quality';

/** Coarse stages reported while converting (OCCT itself exposes no progress callback). */
export type StepStage = 'reading' | 'building' | 'encoding';

export interface StepConvertOptions {
  /** Quality preset id — see `step-quality.ts`. */
  quality: string;
  /** Name of the GLB content root (usually the file name without extension). */
  rootName: string;
  onStage?: (stage: StepStage) => void;
}

export interface StepConvertStats {
  meshes: number;
  triangles: number;
  nodes: number;
  glbBytes: number;
  /** Wall-clock milliseconds per stage. */
  ms: { read: number; build: number; encode: number };
}

export interface StepConvertResult {
  glb: ArrayBuffer;
  stats: StepConvertStats;
}

/** Text of whatever an emscripten call threw (Error, string, or a raw exception pointer). */
function describeThrown(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'number') return `uncaught native exception (code ${e})`;
  return String(e);
}

const NO_GEOMETRY_MESSAGE =
  'The STEP file produced no geometry: it contains nothing OCCT could tessellate, or the '
  + 'in-browser CAD engine ran out of memory while reading it (large assembly). '
  + 'Try the draft quality.';

/**
 * Convert STEP file bytes to GLB bytes (already mm -> m scaled and Z-up -> Y-up rotated,
 * as `CadImportResult` requires).
 *
 * Throws with an actionable message when the file cannot be read or yields no geometry.
 * NOTE: occt-import-js reports an exhausted WASM heap as `success: true` with empty
 * geometry rather than as an error (see `scripts/patch-occt-memory.mjs`) — that case is
 * turned into {@link NO_GEOMETRY_MESSAGE} here.
 */
export async function convertStepToGlb(
  occt: OcctModule,
  bytes: Uint8Array,
  options: StepConvertOptions,
): Promise<StepConvertResult> {
  const t0 = now();
  options.onStage?.('reading');
  let result: ReturnType<OcctModule['ReadStepFile']>;
  try {
    result = occt.ReadStepFile(bytes, stepTessellationParams(options.quality));
  } catch (e) {
    throw new Error(`STEP read failed: ${describeThrown(e)}`);
  }
  if (!result?.success) {
    throw new Error('The file could not be read as STEP (unsupported or corrupt file, or no free shapes in it).');
  }
  const t1 = now();

  options.onStage?.('building');
  const materials = new StepMaterialCache();
  const built = buildHierarchy(result, { rootName: options.rootName, materials });
  if (built.meshCount === 0) throw new Error(NO_GEOMETRY_MESSAGE);
  // Free the (large) OCCT result as early as possible — the tree holds Float32 copies.
  result = { success: true };
  const root = normalizeStepRoot(built.root);
  const t2 = now();

  options.onStage?.('encoding');
  let glb: ArrayBuffer;
  try {
    glb = await encodeGlb(root, built.triangleCount, built.meshCount);
    assertGlbMeshCount(glb, built.meshCount, 'step-import');
  } finally {
    disposeTree(root);
    materials.dispose();
  }
  const t3 = now();

  return {
    glb,
    stats: {
      meshes: built.meshCount,
      triangles: built.triangleCount,
      nodes: built.nodeCount,
      glbBytes: glb.byteLength,
      ms: { read: t1 - t0, build: t2 - t1, encode: t3 - t2 },
    },
  };
}

/**
 * Binary GLB of `root`. The root is passed directly (not wrapped in a Scene), so
 * GLTFExporter adds its synthetic `AuxScene` wrapper; `parseGlbSubtree` strips it on
 * load and keeps the root's own name and transform (pinned by
 * `tests/rv-cad-glb-roundtrip.test.ts`). `onlyVisible: false` mirrors `objectToGlb`.
 */
async function encodeGlb(root: Object3D, triangles: number, meshes: number): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();

  // Upstream leaves the promise unsettled when the first Blob read fails: the TypeError
  // is thrown inside a FileReader handler, where no promise can see it. Catch it on the
  // global scope (window or worker) so a too-large model fails fast instead of hanging.
  const scope = globalThis as unknown as {
    addEventListener?: (type: 'error', cb: (e: ErrorEvent) => void) => void;
    removeEventListener?: (type: 'error', cb: (e: ErrorEvent) => void) => void;
  };
  let onError: ((e: ErrorEvent) => void) | null = null;
  const assemblyFailure = new Promise<never>((_, reject) => {
    onError = (e: ErrorEvent) => {
      if (e.error instanceof TypeError && /byteLength/.test(e.error.message)) {
        e.preventDefault();
        reject(tooLargeError(triangles, meshes));
      }
    };
    scope.addEventListener?.('error', onError);
  });

  try {
    const result = await Promise.race([
      exporter.parseAsync(root, { binary: true, onlyVisible: false }),
      assemblyFailure,
    ]);
    if (!(result instanceof ArrayBuffer)) throw tooLargeError(triangles, meshes);
    return result;
  } finally {
    if (onError) scope.removeEventListener?.('error', onError);
  }
}

function tooLargeError(triangles: number, meshes: number): Error {
  return new Error(
    `Model too large to encode as a single GLB (${meshes.toLocaleString()} meshes, `
    + `~${triangles.toLocaleString()} triangles): the browser ran out of memory while assembling `
    + 'the file. Re-import with a coarser tessellation quality (draft).',
  );
}

function disposeTree(root: Object3D): void {
  root.traverse((node) => {
    (node as Mesh).geometry?.dispose?.();
  });
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
