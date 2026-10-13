// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-import-tab — the "STEP" tab of the Unified Import Dialog: it shows up in the dialog
 * once `registerStepImport()` ran, and picking a file / a quality publishes the dialog input
 * the provider's `resolve` consumes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RVViewer } from '../src/core/rv-viewer';
import { importProviderRegistry, type ImportProviderContext } from '../src/core/import/rv-import-provider';
import { registerCadProvider } from '../src/core/editor/rv-cad-provider';
import { UnifiedImportDialog } from '../src/plugins/unified-import/UnifiedImportDialog';
import { registerStepImport, createStepImportProvider, type StepImportInput } from '../src/plugins/community-editor/step-import';

afterEach(() => {
  cleanup();
  registerCadProvider('step', null);
  importProviderRegistry.unregister('step');
});

function stubContext() {
  const setInput = vi.fn();
  const registerFilePicker = vi.fn();
  const ctx = { viewer: {} as RVViewer, close: vi.fn(), setInput, registerFilePicker } as ImportProviderContext;
  return { ctx, setInput, registerFilePicker };
}

describe('STEP dialog tab', () => {
  it('appears as a tab in the Unified Import Dialog after registerStepImport()', () => {
    registerStepImport();
    const viewer = { modes: { activeMode: 'editor' } } as unknown as RVViewer;
    render(<UnifiedImportDialog viewer={viewer} open onClose={() => undefined} />);
    expect(screen.getByRole('tab', { name: 'STEP' })).toBeTruthy();
  });

  it('publishes the picked files with the default quality, then with the chosen one', () => {
    const { ctx, setInput, registerFilePicker } = stubContext();
    const { container } = render(<>{createStepImportProvider().renderConfigTab(ctx)}</>);
    // The tab registers its footer file picker.
    expect(registerFilePicker).toHaveBeenCalledWith(expect.objectContaining({ openPicker: expect.any(Function) }));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('.step,.stp');
    const file = new File(['ISO-10303-21;'], 'gearbox.stp');
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText('gearbox.stp')).toBeTruthy();
    const first = setInput.mock.calls.at(-1)![0] as { kind: string; data: StepImportInput };
    expect(first.kind).toBe('custom');
    expect(first.data.files).toEqual([file]);
    expect(first.data.quality).toBe('standard');

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: /Fine/ }));
    const second = setInput.mock.calls.at(-1)![0] as { kind: string; data: StepImportInput };
    expect(second.data.quality).toBe('fine');
    expect(second.data.files).toEqual([file]);
  });

  it('is always available (the conversion is browser-local)', () => {
    expect(createStepImportProvider().availability()).toBe('ready');
  });
});
