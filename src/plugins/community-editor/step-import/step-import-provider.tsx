// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-import-provider — the "STEP" tab of the Unified Import Dialog.
 *
 * Reads local `.step` / `.stp` files, converts each in a browser-local worker
 * (nothing is uploaded) and hands GLB bytes + CADLink provenance to the editor sink
 * (`ImportResultItem` of kind `glb` carrying `cadlink`).
 *
 * Progress: OCCT has no progress callback, so the bar stays indeterminate
 * (`percent: null`) and the label names the current stage — no invented numbers.
 */

import { useCallback, useRef, useState } from 'react';
import { Box } from '@mui/material';
import type {
  CadImportProvider,
  ImportProgressListener,
  ImportProviderContext,
  ImportProviderInput,
  ImportProviderResult,
  ImportResultItem,
} from '../../../core/import/rv-import-provider';
import {
  FileDropZone, HintCode, PickedFileList, SettingRow, SettingSelect, TAB_PANE_SX, TabHint,
  useRegisterFilePicker, type PickedFile,
} from '../../unified-import/import-ui';
import { importStepFile, stepBaseName, type StepConverter } from './step-provider';
import { DEFAULT_STEP_QUALITY, type StepQuality } from './step-quality';
import type { StepConversionStage } from './step-worker-client';
import { convertStepInWorker } from './step-worker-client';

const ACCEPT = ['.step', '.stp'];

/** Value passed through `ImportProviderInput` `{ kind: 'custom' }` by this tab. */
export interface StepImportInput {
  files: File[];
  quality: StepQuality;
}

const QUALITY_OPTIONS: { value: StepQuality; label: string }[] = [
  { value: 'draft', label: 'Draft (fast, light)' },
  { value: 'standard', label: 'Standard' },
  { value: 'fine', label: 'Fine (slow, heavy)' },
];

const STAGE_LABEL: Record<StepConversionStage, string> = {
  'loading-engine': 'Loading CAD engine',
  reading: 'Tessellating STEP (OCCT)',
  building: 'Building scene',
  encoding: 'Encoding GLB',
};

function isStepInput(data: unknown): data is StepImportInput {
  return !!data && typeof data === 'object' && Array.isArray((data as StepImportInput).files);
}

/** Normalise any dialog input to `{ files, quality }`; null when it carries no STEP files. */
function toStepInput(input: ImportProviderInput): StepImportInput | null {
  if (input.kind === 'custom' && isStepInput(input.data)) return input.data;
  if (input.kind === 'file') return { files: [input.file], quality: DEFAULT_STEP_QUALITY };
  if (input.kind === 'files') return { files: input.files, quality: DEFAULT_STEP_QUALITY };
  return null;
}

/**
 * Pure resolve step (unit-testable without the dialog): STEP files -> GLB items.
 * A failing file lands in `failed` (partial success); Cancel aborts the whole call.
 */
export async function resolveStepFiles(
  input: StepImportInput,
  onProgress?: ImportProgressListener,
  signal?: AbortSignal,
  convert: StepConverter = convertStepInWorker,
): Promise<ImportProviderResult> {
  const ok: ImportResultItem[] = [];
  const failed: { id: string; error: string }[] = [];
  const total = input.files.length;
  for (let i = 0; i < total; i++) {
    const file = input.files[i];
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    const prefix = total > 1 ? `${file.name} (${i + 1}/${total}) — ` : '';
    onProgress?.({ percent: null, label: `${prefix}Reading file`, detail: 'Converted in your browser — nothing is uploaded.' });
    try {
      const { glb, cadlink } = await importStepFile(
        file,
        input.quality,
        {
          signal,
          onStage: (stage) => onProgress?.({
            percent: null,
            label: `${prefix}${STAGE_LABEL[stage]}`,
            detail: stage === 'reading' ? 'No progress is available while OCCT tessellates.' : undefined,
          }),
        },
        convert,
      );
      ok.push({ kind: 'glb', bytes: glb, suggestedName: stepBaseName(file.name), cadlink });
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e;
      failed.push({ id: file.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok, failed };
}

function StepFileTab({ ctx }: { ctx: ImportProviderContext }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [quality, setQuality] = useState<StepQuality>(DEFAULT_STEP_QUALITY);
  const filesRef = useRef<File[]>([]);
  useRegisterFilePicker(ctx, inputRef);

  const publish = useCallback((files: File[], q: StepQuality) => {
    ctx.setInput(files.length > 0 ? { kind: 'custom', data: { files, quality: q } satisfies StepImportInput } : null);
  }, [ctx]);

  const selectFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    filesRef.current = files;
    setPicked(files.map((f) => ({ name: f.name, size: f.size })));
    publish(files, quality);
  }, [publish, quality]);

  const changeQuality = useCallback((q: StepQuality) => {
    setQuality(q);
    publish(filesRef.current, q);
  }, [publish]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    selectFiles(files);
  }, [selectFiles]);

  return (
    <Box sx={TAB_PANE_SX}>
      <TabHint>
        Import one or more <HintCode>.step</HintCode> / <HintCode>.stp</HintCode> files.
        They are converted in your browser — nothing is uploaded.
      </TabHint>
      <FileDropZone accept={ACCEPT} onFiles={selectFiles} />
      <PickedFileList files={picked} placeholder="No files selected — drop them above or use Choose files… below." />
      <SettingRow
        label="Tessellation quality"
        tooltip="Finer quality rounds curved parts better but produces many more triangles and needs more memory."
      >
        <SettingSelect value={quality} onChange={changeQuality} options={QUALITY_OPTIONS} />
      </SettingRow>
      <input
        ref={inputRef}
        type="file"
        accept=".step,.stp"
        multiple
        style={{ display: 'none' }}
        onChange={handleChange}
      />
    </Box>
  );
}

/** Create the STEP dialog provider (registered by `registerStepImport`). */
export function createStepImportProvider(convert: StepConverter = convertStepInWorker): CadImportProvider {
  return {
    id: 'step',
    label: 'STEP',
    order: 20,
    availability: () => 'ready',
    onAvailabilityChange: () => () => undefined,
    renderConfigTab: (ctx: ImportProviderContext) => <StepFileTab ctx={ctx} />,
    resolve: async (input, onProgress, signal): Promise<ImportProviderResult> => {
      const step = toStepInput(input);
      if (!step || step.files.length === 0) {
        return { ok: [], failed: [{ id: 'step', error: 'No file selected' }] };
      }
      return resolveStepFiles(step, onProgress, signal, convert);
    },
  };
}
