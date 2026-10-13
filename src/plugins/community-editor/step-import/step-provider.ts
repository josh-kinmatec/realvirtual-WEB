// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-provider — the `CadGeometryProvider` for STEP files, built on occt-import-js.
 *
 * `importFile` hashes the ORIGINAL bytes (that SHA-256 is the cache key the core uses
 * for the converted GLB), converts in a worker, and returns GLB bytes plus the CADLink
 * extras. `retessellate` rebuilds an evicted GLB from the original bytes kept in
 * `step-source-cache` and re-populates the GLB cache.
 *
 * `importFile` deliberately does NOT consult the GLB cache for a hit: the cache key
 * `(sha256, quality)` does not capture this module's own tessellation settings, so a
 * stale hit would hide a parameter change. Only `retessellate` (explicitly a rebuild)
 * writes the cache; `AssetDocument.importCad` writes it for fresh imports.
 */

import type { CadGeometryProvider, CadImportResult } from '../../../core/editor/rv-cad-provider';
import type { CADLinkExtras } from '../../../core/editor/rv-asset-ops';
import { putCadGlb, sha256Hex } from '../../../core/import/rv-cad-glb-cache';
import { STEP_MM_TO_M } from './occt-to-three';
import { normalizeStepQuality } from './step-quality';
import { getStepSource, putStepSource } from './step-source-cache';
import {
  convertStepInWorker,
  type StepConversionOptions,
  type StepConversionStage,
} from './step-worker-client';

/** Strip directories and a `.step` / `.stp` (or any) extension: `a/Gearbox.stp` -> `Gearbox`. */
export function stepBaseName(fileName: string): string {
  const file = fileName.split(/[\\/]/).pop() ?? fileName;
  return file.replace(/\.[^./\\]+$/, '') || 'STEP';
}

/** Per-call hooks used by the dialog tab (the bare `CadGeometryProvider` API has none). */
export interface StepImportHooks {
  onStage?: (stage: StepConversionStage) => void;
  signal?: AbortSignal;
}

/** Test seam: replace the worker conversion. */
export type StepConverter = typeof convertStepInWorker;

/**
 * Convert one STEP `File` to `{ glb, cadlink }`.
 *
 * `Quality` in the returned CADLink is the NORMALISED preset id (`draft | standard | fine`),
 * which is also what keys the GLB cache.
 */
export async function importStepFile(
  file: File,
  quality: string,
  hooks: StepImportHooks = {},
  convert: StepConverter = convertStepInWorker,
): Promise<CadImportResult> {
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error(`"${file.name}" is empty`);
  const q = normalizeStepQuality(quality);

  // Hash + snapshot BEFORE the buffer is transferred to the worker (which detaches it).
  const sha256 = await sha256Hex(bytes);
  const sourceStored = putStepSource(sha256, new Blob([bytes]));

  const options: StepConversionOptions = {
    quality: q,
    rootName: stepBaseName(file.name),
    onStage: hooks.onStage,
    signal: hooks.signal,
  };
  let glb: ArrayBuffer;
  try {
    ({ glb } = await convert(bytes, options));
  } finally {
    await sourceStored; // never rejects; keeps the write from outliving the import
  }

  const cadlink: CADLinkExtras = {
    File: file.name,
    Sha256: sha256,
    Quality: q,
    ImportScaleFactor: STEP_MM_TO_M,
    ZIsUpVector: true,
  };
  return { glb, cadlink };
}

/** Create the STEP geometry provider registered under `registerCadProvider('step', …)`. */
export function createStepCadProvider(convert: StepConverter = convertStepInWorker): CadGeometryProvider {
  return {
    importFile: (file, quality) => importStepFile(file, quality, {}, convert),

    async retessellate(cadlink: CADLinkExtras): Promise<ArrayBuffer | null> {
      const source = await getStepSource(cadlink.Sha256);
      if (!source) return null;
      const { glb } = await convert(source, {
        quality: normalizeStepQuality(cadlink.Quality),
        rootName: stepBaseName(cadlink.File),
      });
      // Re-populate under the EXACT key the importCad op looks up.
      await putCadGlb(cadlink.Sha256, cadlink.Quality, glb);
      return glb;
    },
  };
}
