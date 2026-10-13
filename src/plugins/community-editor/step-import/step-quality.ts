// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-quality — tessellation quality presets for the STEP import.
 *
 * Callers pass a free-form preset id (`web_editor_import_cad` documents
 * `draft | standard | fine`; `CADLinkExtras.Quality` also mentions `coarse`).
 * The repo defines no numeric meaning for them, so the mapping below is OUR
 * choice, not a documented contract:
 *
 *   - `standard` is exactly occt-import-js's own default
 *     (`linearDeflection 0.001` of the average bounding-box size, `angularDeflection 0.5`).
 *   - `draft` (alias `coarse`) is ~4x coarser linear / wider angular — meant for
 *     machines with many small parts where a quick, light model matters more.
 *   - `fine` is ~5x finer linear / half the angle — round parts get visibly rounder,
 *     at several times the triangle count.
 *
 * The deflection is a RATIO of the average bounding-box edge of each top-level shape
 * (`bounding_box_ratio`), so a preset behaves the same for a 50 mm part and a 10 m cell.
 * Unknown ids fall back to `standard`.
 *
 * NOTE: the preset id is part of the converted-GLB cache key. If these numbers are ever
 * retuned under the same id, bump `CACHE_VERSION` in `core/import/rv-cad-glb-cache.ts`.
 */

export type StepQuality = 'draft' | 'standard' | 'fine';

export const STEP_QUALITIES: readonly StepQuality[] = ['draft', 'standard', 'fine'];

export const DEFAULT_STEP_QUALITY: StepQuality = 'standard';

/** Normalise a free-form quality id to one of the three presets. */
export function normalizeStepQuality(quality: string | null | undefined): StepQuality {
  const q = (quality ?? '').trim().toLowerCase();
  if (q === 'draft' || q === 'coarse' || q === 'low') return 'draft';
  if (q === 'fine' || q === 'high') return 'fine';
  return 'standard';
}

/** Parameters handed to `occt.ReadStepFile` (occt-import-js README, "How to use?"). */
export interface StepTessellationParams {
  linearUnit: 'millimeter';
  linearDeflectionType: 'bounding_box_ratio';
  linearDeflection: number;
  angularDeflection: number;
}

const PRESETS: Record<StepQuality, { linearDeflection: number; angularDeflection: number }> = {
  draft: { linearDeflection: 0.004, angularDeflection: 0.8 },
  standard: { linearDeflection: 0.001, angularDeflection: 0.5 },
  fine: { linearDeflection: 0.0002, angularDeflection: 0.25 },
};

/**
 * OCCT parameters for a quality preset. The output unit is always millimetres;
 * the mm -> m factor is applied on the content root (see `normalizeStepRoot`).
 */
export function stepTessellationParams(quality: string | null | undefined): StepTessellationParams {
  const preset = PRESETS[normalizeStepQuality(quality)];
  return {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: preset.linearDeflection,
    angularDeflection: preset.angularDeflection,
  };
}
