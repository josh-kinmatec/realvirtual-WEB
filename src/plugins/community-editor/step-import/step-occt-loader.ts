// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-occt-loader — instantiate the `occt-import-js` WASM module.
 *
 * The emscripten glue finds its `.wasm` next to the script it was loaded from, which
 * stops being true once a bundler prebundles / chunks the glue. The `.wasm` is therefore
 * imported as a URL (`?url`: Vite serves it in dev and emits it as an asset in a build)
 * and handed to the glue through `locateFile`. No path is hard-coded, nothing is fetched
 * from outside the app.
 *
 * `scripts/patch-occt-memory.mjs` has already raised the heap ceiling of the installed
 * wasm/glue to 4 GB (postinstall); nothing is needed here for that.
 *
 * A module instance owns its own WASM heap, and a heap never shrinks. The worker client
 * therefore uses ONE instance per conversion and terminates the worker afterwards.
 */

import occtimportjs, { type OcctModule } from 'occt-import-js';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

/** Create a fresh `occt-import-js` instance (own WASM memory). */
export function loadOcct(): Promise<OcctModule> {
  return occtimportjs({
    locateFile: (path: string, scriptDirectory: string) =>
      path.endsWith('.wasm') ? occtWasmUrl : scriptDirectory + path,
  });
}
