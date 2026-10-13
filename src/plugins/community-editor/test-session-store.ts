// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * test-session-store — the observable state of the editor's in-place test run.
 *
 * The community editor does not implement an in-place test session (the
 * materialise-through-save, attach-the-runtime, restore-exactly cycle). The store
 * still exists because the MCP bridge and the mechanism force recorder read it:
 * with no session registered the state is `idle` and `getActiveTestSession()`
 * answers null, which the MCP tools turn into an explicit "no test session
 * available" message. A future implementation registers itself through
 * {@link setActiveTestSession} without any caller having to change.
 */

export type TestSessionState = 'idle' | 'preparing' | 'running' | 'restoring' | 'failed';

export interface InPlaceTestSessionLike {
  state: TestSessionState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

let _session: InPlaceTestSessionLike | null = null;
let _state: TestSessionState = 'idle';
const _listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [..._listeners]) fn();
}

export function getTestSessionState(): TestSessionState {
  return _state;
}

export function getActiveTestSession(): InPlaceTestSessionLike | null {
  return _session;
}

export function subscribeTestSession(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Register (or clear with null) the live session. Called by whoever implements one. */
export function setActiveTestSession(session: InPlaceTestSessionLike | null): void {
  _session = session;
  if (!session) _state = 'idle';
  notify();
}

/** Publish a state change of the live session. */
export function setTestSessionState(state: TestSessionState): void {
  if (_state === state) return;
  _state = state;
  notify();
}
