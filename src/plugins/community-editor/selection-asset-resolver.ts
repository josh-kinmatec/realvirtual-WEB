// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * selection-asset-resolver — "which asset is this selected node part of?".
 *
 * The editor opens what you were looking at: select a placed object in the
 * planner and switch to the editor, and it opens the library asset that object
 * was placed from. The editor cannot know how placements map to assets — that is
 * the planner's business — so each workspace that can answer REGISTERS a resolver
 * and the editor asks all of them. The first non-null answer wins.
 *
 * Resolvers run inside a mode switch, so a throwing one is skipped with a warning
 * instead of aborting the switch.
 */

import type { AssetBase } from '../../core/editor/rv-asset-document';

export type SelectionAssetResolver = (path: string) => AssetBase | null;

const _resolvers = new Set<SelectionAssetResolver>();

/** Register a resolver. Returns the unregister function. */
export function registerSelectionAssetResolver(fn: SelectionAssetResolver): () => void {
  _resolvers.add(fn);
  return () => { _resolvers.delete(fn); };
}

/** The asset the node at `path` belongs to, or null when nobody recognises it. */
export function resolveSelectionToAsset(path: string): AssetBase | null {
  for (const resolve of [..._resolvers]) {
    try {
      const base = resolve(path);
      if (base) return base;
    } catch (e) {
      console.warn('[asset-editor] a selection→asset resolver threw — skipped:', e);
    }
  }
  return null;
}

/** Same as {@link resolveSelectionToAsset}; the name the pre-existing stub exported. */
export const resolveSelectionAsset = resolveSelectionToAsset;

/** Tests only: forget every registered resolver. */
export function _clearSelectionAssetResolvers(): void {
  _resolvers.clear();
}
