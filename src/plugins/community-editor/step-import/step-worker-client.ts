// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-worker-client — main-thread side of the STEP conversion worker.
 *
 * Each conversion gets its OWN worker, terminated afterwards: an OCCT/WASM heap grows
 * with the largest assembly it has seen and never shrinks, so a long-lived worker would
 * pin gigabytes after one big import. Termination is also what makes Cancel real — OCCT
 * exposes no progress or cancel hook, but killing the worker stops it at once.
 *
 * Everything runs browser-locally: the file bytes go to a same-origin worker, never to a
 * server.
 *
 * Without `Worker` support (or if constructing one fails) the conversion runs inline on
 * the main thread — same code, but the page freezes for the duration. That path exists
 * for restricted environments, not as the normal route.
 *
 * The `new Worker(new URL(...))` reference lives in THIS file, not in the worker's own
 * import graph, so the worker bundle never contains a nested copy of itself.
 */

import type { StepConvertResult, StepStage } from './step-convert';
import type { StepWorkerRequest, StepWorkerResponse } from './step-worker-protocol';

export type StepConversionStage = StepStage | 'loading-engine';

export interface StepConversionOptions {
  quality: string;
  rootName: string;
  onStage?: (stage: StepConversionStage) => void;
  /** Aborting terminates the worker and rejects with an `AbortError`. */
  signal?: AbortSignal;
  /**
   * Worker factory. Default: the bundled `step-import-worker`. Return `null` to force the
   * inline (main-thread) fallback. Injectable for tests.
   */
  createWorker?: () => Worker | null;
}

function abortError(): DOMException {
  return new DOMException('STEP import cancelled', 'AbortError');
}

function defaultCreateWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./step-import-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/**
 * Convert STEP bytes to GLB in a dedicated worker. `bytes` is TRANSFERRED to the worker
 * (detached on the caller's side) — copy it first if you still need it.
 */
export async function convertStepInWorker(
  bytes: ArrayBuffer,
  options: StepConversionOptions,
): Promise<StepConvertResult> {
  if (options.signal?.aborted) throw abortError();
  const worker = (options.createWorker ?? defaultCreateWorker)();
  if (!worker) return convertInline(bytes, options);

  return new Promise<StepConvertResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      fn();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    options.signal?.addEventListener('abort', onAbort);

    worker.onmessage = (ev: MessageEvent<StepWorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'progress') options.onStage?.(msg.stage);
      else if (msg.type === 'done') finish(() => resolve({ glb: msg.glb, stats: msg.stats }));
      else if (msg.type === 'error') finish(() => reject(new Error(msg.message)));
    };
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      finish(() => reject(new Error(
        `The STEP conversion worker failed${ev.message ? `: ${ev.message}` : ' to start'}`,
      )));
    };
    worker.onmessageerror = () => finish(() => reject(new Error('The STEP conversion worker sent an unreadable message')));

    const request: StepWorkerRequest = {
      type: 'convert',
      bytes,
      quality: options.quality,
      rootName: options.rootName,
    };
    try {
      worker.postMessage(request, [bytes]);
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

/** Main-thread fallback: identical conversion core, blocks the UI while OCCT runs. */
async function convertInline(bytes: ArrayBuffer, options: StepConversionOptions): Promise<StepConvertResult> {
  const [{ convertStepToGlb }, { loadOcct }] = await Promise.all([
    import('./step-convert'),
    import('./step-occt-loader'),
  ]);
  options.onStage?.('loading-engine');
  const occt = await loadOcct();
  if (options.signal?.aborted) throw abortError();
  return convertStepToGlb(occt, new Uint8Array(bytes), {
    quality: options.quality,
    rootName: options.rootName,
    onStage: options.onStage,
  });
}
