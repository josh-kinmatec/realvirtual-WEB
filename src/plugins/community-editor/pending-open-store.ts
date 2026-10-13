// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pending-open-store — the one-shot "open THIS asset when the editor starts" slot.
 *
 * Whoever wants the editor to open a specific document (the projects dashboard,
 * the planner's "Edit asset", a `?doc=new&mode=editor` deep link, the MCP
 * `web_editor_open` tool) writes the identity here and then switches the mode.
 * The editor consumes it exactly once on activation. An explicit request always
 * outranks every other way the editor can pick what to open (the selection, the
 * last edited asset), because it is the only one that states an intent.
 */

import type { AssetBase } from '../../core/editor/rv-asset-document';

let _pending: AssetBase | null = null;

/** Ask the editor to open `base` on its next activation (replaces an earlier request). */
export function setPendingAssetOpen(base: AssetBase): void {
  _pending = base;
}

/** The pending request, WITHOUT consuming it. */
export function peekPendingAssetOpen(): AssetBase | null {
  return _pending;
}

/** The pending request, consumed: the next call answers null. */
export function takePendingAssetOpen(): AssetBase | null {
  const base = _pending;
  _pending = null;
  return base;
}
