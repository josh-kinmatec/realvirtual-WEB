// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-source-cache — keeps the ORIGINAL STEP bytes so `retessellate` can rebuild an
 * evicted converted GLB.
 *
 * Storage: the origin-private, SHA-addressed blob store (`core/storage/rv-opfs-blobs`),
 * keyed by the SHA-256 of the file's own bytes — the same value as `CADLinkExtras.Sha256`,
 * so the lookup key is already in every CADLink. Nothing leaves the browser.
 *
 * Both calls are best-effort: no OPFS, a full quota or a missing blob is a cache miss,
 * never an error (the caller then surfaces a re-pick prompt).
 */

import { getBlob, isOpfsSupported, putBlob } from '../../../core/storage/rv-opfs-blobs';

/** Store the original bytes under their SHA-256. Resolves `false` when nothing was stored. */
export async function putStepSource(sha256: string, blob: Blob): Promise<boolean> {
  if (!isOpfsSupported()) return false;
  try {
    await putBlob(sha256, blob);
    return true;
  } catch {
    return false;
  }
}

/** The original bytes for a content hash, or null when they are not (or no longer) cached. */
export async function getStepSource(sha256: string): Promise<ArrayBuffer | null> {
  if (!isOpfsSupported()) return null;
  try {
    const blob = await getBlob(sha256);
    return blob ? await blob.arrayBuffer() : null;
  } catch {
    return null;
  }
}
