// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-import-worker — thin Web Worker wrapper around `convertStepToGlb`.
 *
 * One job per worker: it initialises a fresh OCCT module, converts, posts the GLB (as a
 * transferable) and is then terminated by the client, which frees the whole WASM heap.
 * All logic lives in `step-convert.ts`; this file only does message plumbing.
 */

import { convertStepToGlb } from './step-convert';
import { loadOcct } from './step-occt-loader';
import type { StepWorkerRequest, StepWorkerResponse } from './step-worker-protocol';

const scope = self as unknown as {
  postMessage(message: StepWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<StepWorkerRequest>) => void) | null;
};

function post(message: StepWorkerResponse, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

scope.onmessage = async (ev: MessageEvent<StepWorkerRequest>) => {
  const request = ev.data;
  if (request?.type !== 'convert') return;
  try {
    post({ type: 'progress', stage: 'loading-engine' });
    const occt = await loadOcct();
    const { glb, stats } = await convertStepToGlb(occt, new Uint8Array(request.bytes), {
      quality: request.quality,
      rootName: request.rootName,
      onStage: (stage) => post({ type: 'progress', stage }),
    });
    post({ type: 'done', glb, stats }, [glb]);
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
