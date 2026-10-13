// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * document-view — publishes the editor's open document to the shared card seam.
 *
 * The document card (name, dirty dot, Save, undo/redo) and `web_editor_status`'s
 * breadcrumb both read `ActiveDocumentView`. Without a writer for the editor mode
 * they keep showing whatever the previous mode left behind — an agent that opened a
 * fresh document would be told it is editing "realvirtual WEB Demo". The view is a
 * pure projection of the `AssetDocument` snapshot, republished on every change.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { AssetDocument } from '../../core/editor/rv-asset-document';
import {
  clearActiveDocumentViewFor,
  documentLocationCrumbs,
  setActiveDocumentView,
  type ActiveDocumentSaveOutcome,
  type ActiveDocumentView,
  type NamePrompt,
} from '../../core/editor/active-document-view';
import { decideSaveVerb, saveDocument } from '../../core/editor/rv-save-document';
import { getProjectStore } from '../../core/project/project-store';
import { askSaveName, saveDocumentPromptKey, SAVE_PROMPT_BUSY } from '../../core/hmi/scene/save-dialog-store';
import { describeSaveFailure } from './save-flow';

const SOURCE_MODE = 'editor';

function buildView(viewer: RVViewer, doc: AssetDocument): ActiveDocumentView {
  const snap = doc.getSnapshot();
  const verb = decideSaveVerb(
    { lineage: 'asset', base: snap.base, name: snap.name },
    getProjectStore().getBackend(),
  );
  return {
    name: snap.name,
    crumbs: [{
      index: 0,
      label: snap.name,
      occurrence: '',
      referenceNodeId: null,
      dirty: snap.dirty,
      stale: false,
      current: true,
    }],
    location: documentLocationCrumbs(snap.base),
    dirty: snap.dirty,
    busy: snap.busy,
    stackDirty: snap.dirty,
    stale: false,
    saveVerb: verb.verb,
    ...(verb.reason ? { saveReason: verb.reason } : {}),
    sourceMode: SOURCE_MODE,
    canUndo: snap.canUndo,
    canRedo: snap.canRedo,
    undoLabel: snap.undoLabel,
    redoLabel: snap.redoLabel,
    actions: {
      save: (prompt) => saveFromCard(viewer, doc, prompt),
      undo: async () => { await doc.undo(); },
      redo: async () => { await doc.redo(); },
    },
  };
}

/** The card's Save: a named document saves in silence; a nameless one asks. */
async function saveFromCard(
  viewer: RVViewer, doc: AssetDocument, prompt?: NamePrompt,
): Promise<ActiveDocumentSaveOutcome> {
  const result = await saveDocument(viewer, doc, {
    requestName: async (initial) => {
      if (prompt) return prompt(initial, 'Save into project');
      const answer = await askSaveName({ documentKey: saveDocumentPromptKey(doc.name), initial });
      return answer === SAVE_PROMPT_BUSY ? null : answer;
    },
  });
  switch (result.kind) {
    case 'saved': return { status: 'saved' };
    case 'no-op': return { status: 'no-op' };
    case 'cancelled':
    case 'busy': return { status: 'cancelled' };
    case 'blocked': return { status: 'blocked', reason: result.reason };
    default: return { status: 'error', message: describeSaveFailure(result) };
  }
}

/** Publish the view now and on every document change. Returns the disposer. */
export function publishEditorDocumentView(viewer: RVViewer, doc: AssetDocument): () => void {
  const publish = (): void => setActiveDocumentView(buildView(viewer, doc));
  publish();
  const unsubscribe = doc.subscribe(publish);
  return () => {
    unsubscribe();
    clearActiveDocumentViewFor(SOURCE_MODE);
  };
}
