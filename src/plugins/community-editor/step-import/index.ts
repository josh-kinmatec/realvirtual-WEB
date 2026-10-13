// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-import — community STEP import on top of the open-source `occt-import-js`.
 *
 * Call {@link registerStepImport} once from the editor plugin registration. It
 *   1. registers the `CadGeometryProvider` for format `'step'` (what the MCP tool
 *      `web_editor_import_cad` and the CADLink re-import consume), and
 *   2. adds the "STEP" tab to the Unified Import Dialog.
 * STEP files are converted browser-locally in a Web Worker and never uploaded.
 */

import { getCadProvider, registerCadProvider } from '../../../core/editor/rv-cad-provider';
import { importProviderRegistry } from '../../../core/import/rv-import-provider';
import { createStepImportProvider } from './step-import-provider';
import { createStepCadProvider } from './step-provider';

const cadProvider = createStepCadProvider();
const dialogProvider = createStepImportProvider();

/**
 * Register the STEP CAD provider and the dialog tab. Idempotent: calling it again
 * (HMR, repeated plugin init) changes nothing and logs no "already registered" warning.
 */
export function registerStepImport(): void {
  if (getCadProvider('step') !== cadProvider) registerCadProvider('step', cadProvider);
  if (importProviderRegistry.get(dialogProvider.id) !== dialogProvider) {
    importProviderRegistry.register(dialogProvider);
  }
}

export { createStepCadProvider, importStepFile, stepBaseName } from './step-provider';
export { createStepImportProvider, resolveStepFiles, type StepImportInput } from './step-import-provider';
export { convertStepInWorker } from './step-worker-client';
export { buildHierarchy, buildMesh, normalizeStepRoot, STEP_MM_TO_M } from './occt-to-three';
export { normalizeStepQuality, stepTessellationParams, STEP_QUALITIES } from './step-quality';
