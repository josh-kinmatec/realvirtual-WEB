// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Community stand-in for `@rv-private/plugins/step-import/occt-to-three`.
 *
 * `tests/rv-cad-glb-roundtrip.test.ts` imports `buildMesh` / `normalizeStepRoot` from that
 * private path. In a checkout without the private sibling the `@rv-private` alias resolves
 * here, so the test runs against the community implementation.
 */
export {
  buildMesh,
  buildHierarchy,
  normalizeStepRoot,
  StepMaterialCache,
  STEP_MM_TO_M,
  type OcctMeshData,
  type OcctNodeData,
  type OcctResultData,
} from '../../../plugins/community-editor/step-import/occt-to-three';
