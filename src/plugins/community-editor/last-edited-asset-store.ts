// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * last-edited-asset-store — the editor's memory of the asset it opened last.
 *
 * Read as the last fallback of the editor's open chain: with no explicit request
 * and nothing on screen, "open the editor" resumes whatever was edited most
 * recently, even across a browser restart.
 *
 * It stores an IDENTITY (a document id + path, or provider/source/asset ids),
 * never a URL: `blob:` URLs die with the tab, and a persisted one would make every
 * resume fail silently. Reads are defensive — an unknown schema version, corrupt
 * JSON or an incomplete base all read as "no memory". Records written by older
 * builds (`libraryGlb`, `projectDocument`) are upgraded on read; an old SCENE
 * record is refused, because a scene was never re-openable by path.
 */

import type { AssetBase } from '../../core/editor/rv-asset-document';
import { isLegacyAssetBase, upgradeLegacyAssetBase } from '../../core/editor/rv-asset-draft-storage';
import { EDITOR_LAST_ASSET_KEY } from '../../core/hmi/rv-storage-keys';

const SCHEMA_VERSION = 1;

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Can this base be reopened later from its identity alone? */
function isRestorableBase(value: unknown): value is AssetBase {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  switch (b['kind']) {
    // A path-less document is addressed through a scene body slot — not re-openable here.
    case 'document': return isStr(b['documentId']) && isStr(b['path']) && typeof b['name'] === 'string';
    case 'providerAsset':
      return isStr(b['providerId']) && isStr(b['sourceId']) && isStr(b['assetId']) && typeof b['label'] === 'string';
    case 'builtinModel':
      return isStr(b['url']) && !/^(blob|data):/i.test(b['url'] as string) && typeof b['name'] === 'string';
    case 'referencedAsset':
      return isStr(b['assetId']) && typeof b['label'] === 'string';
    default: return false;
  }
}

/** Remember `base`. A base that cannot be restored is ignored and leaves the old memory intact. */
export function saveLastEditedAsset(base: AssetBase): void {
  if (!isRestorableBase(base)) return;
  try {
    localStorage.setItem(EDITOR_LAST_ASSET_KEY, JSON.stringify({ v: SCHEMA_VERSION, base, savedAt: Date.now() }));
  } catch { /* storage unavailable — memory is best effort */ }
}

/** The remembered base, or null when there is none, or it is unreadable. */
export function loadLastEditedAsset(): AssetBase | null {
  try {
    const raw = localStorage.getItem(EDITOR_LAST_ASSET_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as { v?: unknown; base?: unknown };
    if (rec?.v !== SCHEMA_VERSION) return null;
    const stored = isLegacyAssetBase(rec.base) ? upgradeLegacyAssetBase(rec.base) : rec.base;
    return isRestorableBase(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function clearLastEditedAsset(): void {
  try { localStorage.removeItem(EDITOR_LAST_ASSET_KEY); } catch { /* ignore */ }
}
