// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * button-sim-store — a tiny external store that lets an MCP tool "press" a UI
 * button the way a person would: hover, pressed, release.
 *
 * `simulateButtonClick(id)` looks the button up by `data-rv-button-id` in the
 * DOM, walks the store through `hover` → `pressed` → released, and resolves at
 * the release — which is when the caller (`prepareEditorChoreography`) lets the
 * real edit run, so it lands exactly where a click would have. A UI layer can
 * render a cursor/ripple from {@link getButtonSimSnapshot}; without any UI, or
 * with the button absent from the DOM, the call resolves immediately and the
 * store stays idle. It never dispatches a click itself — the tool performs the
 * edit — and it never throws.
 *
 * The store is useSyncExternalStore-compatible (`subscribe` + `getButtonSimSnapshot`).
 */

/** Attribute that names a simulatable button in the DOM. */
export const BUTTON_ID_ATTRIBUTE = 'data-rv-button-id';

export type ButtonSimPhase = 'hover' | 'pressed';

/** What the UI should draw right now. */
export interface ButtonSimSnapshot {
  id: string;
  phase: ButtonSimPhase;
  /** Viewport centre of the button (for a cursor overlay). */
  x: number;
  y: number;
}

const DEFAULT_HOVER_MS = 380;
const DEFAULT_PRESS_MS = 160;

let hoverMs = DEFAULT_HOVER_MS;
let pressMs = DEFAULT_PRESS_MS;
let snapshot: ButtonSimSnapshot | null = null;
const listeners = new Set<() => void>();

function publish(next: ButtonSimSnapshot | null): void {
  snapshot = next;
  for (const fn of listeners) fn();
}

/** Subscribe to phase changes. Returns the unsubscribe. */
export function subscribeButtonSim(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The simulated button state, or null while idle. */
export function getButtonSimSnapshot(): ButtonSimSnapshot | null {
  return snapshot;
}

/** Test hook: shorten the hover / pressed dwell times. */
export function _setSimTimingsForTest(hover: number, press: number): void {
  hoverMs = hover;
  pressMs = press;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function findButton(id: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  try {
    return document.querySelector<HTMLElement>(`[${BUTTON_ID_ATTRIBUTE}="${CSS.escape(id)}"]`);
  } catch {
    return null;
  }
}

/**
 * Simulate a human click on the button `id`: hover, press, release. Resolves at
 * the release; resolves at once (no dwell) when the button is not in the DOM.
 */
export async function simulateButtonClick(id: string): Promise<void> {
  const el = findButton(id);
  if (!el) return;
  try {
    const centre = (): { x: number; y: number } => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    publish({ id, phase: 'hover', ...centre() });
    await sleep(hoverMs);
    publish({ id, phase: 'pressed', ...centre() });
    await sleep(pressMs);
  } finally {
    publish(null);
  }
}
