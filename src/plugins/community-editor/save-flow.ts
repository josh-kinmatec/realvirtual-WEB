// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * save-flow — the editor's two entry points onto the ONE save path.
 *
 * Everything that matters about saving (routing, destination binding, compare-and-
 * swap against foreign writes, the op floor, the thumbnail, the `document-saved`
 * announcement) lives in `core/editor/rv-save-document.ts`. This module only adds
 * the two things a CALLER has to decide:
 *
 *  - {@link runSaveFlow} — the interactive verb (Save button, Ctrl+S, "Save as…").
 *    It may ask the user: for a name when the verb is "Save as…", and what to do
 *    when the save cannot happen (offer the download fallback).
 *  - {@link saveAssetAs} — the non-interactive verb (MCP, exit guard). It never
 *    asks; every non-success is returned as an outcome the caller words itself,
 *    through {@link describeSaveFailure}, which is the one place those sentences live.
 *
 * A differing name alone never forks a new file: it RENAMES the document and the
 * save goes to the document's own path. Only the explicit "Save as…" verb
 * (`forceNamePrompt`) writes a copy under a new name.
 */

import type { ActiveAssetContext } from '../../core/editor/active-asset-store';
import type { AssetBase } from '../../core/editor/rv-asset-document';
import { saveDocument, type SaveOutcome } from '../../core/editor/rv-save-document';
import { downloadAssetGlb } from '../../core/editor/rv-asset-library-save';
import {
  askSaveName,
  askSaveProblem,
  saveDocumentPromptKey,
  SAVE_PROMPT_BUSY,
} from '../../core/hmi/scene/save-dialog-store';

/** What {@link saveAssetAs} answers — `saved` carries the names MCP reports back. */
export type SaveAssetOutcome =
  | { kind: 'saved'; fileName: string; projectRelPath: string; base: AssetBase; copied: boolean }
  | SaveOutcome;

export interface SaveFlowOptions {
  /** The "Save as…" verb: ask for a name even though the document has one. */
  forceNamePrompt?: boolean;
}

/** One sentence per way a save can end without writing, for an operator or an agent. */
export function describeSaveFailure(outcome: SaveAssetOutcome | { kind: string; [k: string]: unknown }): string {
  const o = outcome as { kind: string; reason?: string; message?: string };
  switch (o.kind) {
    case 'no-op':
      return 'Nothing to save — the document is unchanged since it was last saved.';
    case 'busy':
      return 'A save of this document is already running — wait for it to finish.';
    case 'cancelled':
      return 'The save was cancelled before anything was written.';
    case 'blocked':
      return o.reason ?? 'This document cannot be saved here.';
    case 'conflict':
      return `${o.message ?? 'The file was changed by someone else.'} Nothing was overwritten.`;
    case 'target-changed':
      return 'The project changed while saving, so the result was not adopted. Open the document again and repeat the save.';
    case 'error':
      return o.message ?? 'The save failed.';
    default:
      return 'Save unavailable in this build';
  }
}

/** Save without ever asking. Renames the document first when `name` differs. */
export async function saveAssetAs(ctx: ActiveAssetContext, name: string): Promise<SaveAssetOutcome> {
  const { viewer, doc } = ctx;
  const wanted = name?.trim();
  if (wanted && wanted !== doc.name) doc.renameDocument(wanted);

  const result = await saveDocument(viewer, doc);
  if (result.kind !== 'saved') return result;
  const projectRelPath = result.relPath;
  return {
    kind: 'saved',
    fileName: projectRelPath.split('/').pop() ?? projectRelPath,
    projectRelPath,
    base: result.base,
    copied: result.copied,
  };
}

/**
 * Save interactively. Resolves true when the document is stored (including the
 * clean no-op), false when nothing was written — the reason has then already been
 * shown to the user.
 */
export async function runSaveFlow(ctx: ActiveAssetContext, opts: SaveFlowOptions = {}): Promise<boolean> {
  const { viewer, doc } = ctx;
  const result = await saveDocument(viewer, doc, {
    forceNamePrompt: opts.forceNamePrompt === true,
    requestName: async (initial) => {
      const answer = await askSaveName({
        documentKey: saveDocumentPromptKey(doc.name),
        initial,
        title: opts.forceNamePrompt ? 'Save as…' : undefined,
        confirmLabel: opts.forceNamePrompt ? 'Save' : undefined,
      });
      // A busy answer means the first prompt is still open: report "no name" so
      // this request becomes a cancelled save and unwinds nothing.
      return answer === SAVE_PROMPT_BUSY ? null : answer;
    },
  });

  switch (result.kind) {
    case 'saved':
    case 'no-op':
      return true;
    case 'cancelled':
    case 'busy':
      return false;
    default: {
      // blocked / conflict / target-changed / error: say WHY and offer the way out.
      const choice = await askSaveProblem({
        reason: describeSaveFailure(result),
        canRetry: false,
        canDownload: true,
      });
      if (choice === 'download') await downloadAssetGlb(viewer, doc, doc.name);
      return false;
    }
  }
}
