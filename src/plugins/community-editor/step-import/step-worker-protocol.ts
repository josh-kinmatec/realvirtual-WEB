// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Message types between `step-worker-client.ts` and `step-import-worker.ts`. */

import type { StepConvertStats, StepStage } from './step-convert';

/** Main -> worker. `bytes` is TRANSFERRED (the sender's buffer is detached). */
export interface StepWorkerRequest {
  type: 'convert';
  bytes: ArrayBuffer;
  quality: string;
  rootName: string;
}

/** Worker -> main. `glb` is TRANSFERRED. */
export type StepWorkerResponse =
  | { type: 'progress'; stage: StepStage | 'loading-engine' }
  | { type: 'done'; glb: ArrayBuffer; stats: StepConvertStats }
  | { type: 'error'; message: string };
