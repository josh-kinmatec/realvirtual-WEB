// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-dialog-store — promise-based dialogs of the authoring workspace.
 *
 * The save dialogs (unsaved / name / save-problem) live in the public
 * `core/hmi/scene/save-dialog-store`. This store carries the editor's remaining
 * authoring questions (a draft conflicts with the asset you asked for, a CAD
 * import report, a mesh operation preview, …). Each is a promise that settles when
 * somebody answers it.
 *
 * ## Automated callers
 *
 * A promise that only settles on a click is fatal for an MCP tool call: it blocks
 * until the bridge's timeout and leaves the dialog on screen. The MCP bridge
 * therefore installs an auto-responder for the duration of each call
 * (`rv-mcp-dialog-policy.ts`); it is consulted before a dialog is published, so an
 * auto-answered dialog never reaches the UI. Returning `undefined` declines and
 * leaves the dialog to the human.
 *
 * This store has no UI of its own in the community build: a dialog nobody
 * answers stays pending. The community editor therefore raises dialogs only where
 * an automated answer exists or where a human is plainly present.
 */

export interface EditorDialogRequest {
  /** Discriminator the auto-responder switches on (`draft-conflict`, `reimport-report`, …). */
  kind: string;
  /** Free-form payload shown by whatever renders the dialog. */
  [key: string]: unknown;
}

/** A published dialog: the request plus the function that settles it. */
export type PendingEditorDialog = EditorDialogRequest & { resolve: (answer: unknown) => void };

/** Answer with this to settle a dialog whose answer carries no value. */
export const DIALOG_AUTO_DISMISS: unique symbol = Symbol('rv-dialog-auto-dismiss');

export type DialogAutoResponder = ((request: EditorDialogRequest) => unknown) | null;

export interface AutoAnsweredEditorDialog {
  kind: string;
  answer: string;
  detail?: string;
}

let _pending: PendingEditorDialog | null = null;
let _responder: DialogAutoResponder = null;
let _autoLog: AutoAnsweredEditorDialog[] = [];
let _version = 0;
const _listeners = new Set<() => void>();

function notify(): void {
  _version++;
  for (const fn of [..._listeners]) fn();
}

/** Install (or clear with null) the automated responder. Returns the previous one. */
export function setDialogAutoResponder(responder: DialogAutoResponder): DialogAutoResponder {
  const previous = _responder;
  _responder = responder;
  return previous;
}

/** Drain the log of dialogs answered automatically since the last call. */
export function takeDialogAutoLog(): AutoAnsweredEditorDialog[] {
  const out = _autoLog;
  _autoLog = [];
  return out;
}

/**
 * Ask a question. Resolves with the answer — from the auto-responder when one is
 * installed and accepts, otherwise from whoever settles the published dialog.
 */
export function askEditorDialog<T = unknown>(request: EditorDialogRequest): Promise<T> {
  return new Promise<T>((resolve) => {
    if (_responder) {
      let answer: unknown;
      // A throwing responder must not strand the dialog: declining is the same outcome.
      try { answer = _responder(request); } catch { answer = undefined; }
      if (answer !== undefined) {
        const dismissed = answer === DIALOG_AUTO_DISMISS;
        _autoLog.push({
          kind: request.kind,
          answer: dismissed ? 'dismissed' : (JSON.stringify(answer) ?? String(answer)),
          ...(typeof request['detail'] === 'string' ? { detail: request['detail'] as string } : {}),
        });
        resolve((dismissed ? undefined : answer) as T);
        return;
      }
    }
    _pending = {
      ...request,
      resolve: (answer: unknown) => {
        _pending = null;
        notify();
        resolve(answer as T);
      },
    };
    notify();
  });
}

export function getPendingDialog(): PendingEditorDialog | null {
  return _pending;
}

export function subscribeEditorDialogs(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** `useSyncExternalStore` snapshot. */
export function getEditorDialogsVersion(): number {
  return _version;
}
