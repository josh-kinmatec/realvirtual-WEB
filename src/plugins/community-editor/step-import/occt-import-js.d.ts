// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Ambient typings for the public npm package `occt-import-js` (0.0.23), which
 * ships none. Written from the package's own README ("Processing the result")
 * and its bundled `occt-import-js/src/js-interface.cpp`; only what the STEP
 * import uses is declared.
 */
declare module 'occt-import-js' {
  /** Triangulation parameters (README: "How to use?"). All optional. */
  export interface OcctImportParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
    linearDeflection?: number;
    angularDeflection?: number;
  }

  export interface OcctFaceRange {
    first: number;
    last: number;
    color: number[] | null;
  }

  export interface OcctMesh {
    name: string;
    color?: number[];
    brep_faces: OcctFaceRange[];
    attributes: {
      position: { array: ArrayLike<number> };
      normal?: { array: ArrayLike<number> };
    };
    index: { array: ArrayLike<number> };
  }

  export interface OcctNode {
    name: string;
    meshes: number[];
    children: OcctNode[];
  }

  export interface OcctImportResult {
    success: boolean;
    root?: OcctNode;
    meshes?: OcctMesh[];
  }

  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: OcctImportParams | null): OcctImportResult;
    ReadIgesFile(content: Uint8Array, params: OcctImportParams | null): OcctImportResult;
    ReadBrepFile(content: Uint8Array, params: OcctImportParams | null): OcctImportResult;
  }

  /** The subset of emscripten `Module` overrides the loader passes. */
  export interface OcctModuleOverrides {
    locateFile?: (path: string, scriptDirectory: string) => string;
  }

  const occtimportjs: (overrides?: OcctModuleOverrides) => Promise<OcctModule>;
  export default occtimportjs;
}
