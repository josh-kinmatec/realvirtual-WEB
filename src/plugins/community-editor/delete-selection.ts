// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * delete-selection — the shared delete path behind the Delete key and the
 * `web_editor_delete` tool.
 *
 * Deleting an ancestor trashes its whole subtree, so a selection that holds both
 * a parent and its child must only delete the parent (the child's op would
 * address a node that is no longer where its path says). The selection is
 * therefore pruned segment-aware first, then deleted as ONE undo unit
 * (`AssetDocument.deleteNodes`).
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { AssetDocument } from '../../core/editor/rv-asset-document';
import { isModelRoot } from '../../core/engine/rv-model-root';

/**
 * Drop duplicates and every path that lies below another path of the set.
 *
 * Segment-aware: `A/Conv2` is not below `A/Conv`. Selection order is preserved
 * and the result does not depend on the order ancestors and descendants arrive
 * in. A leading `/` (an unnamed asset root) is handled — the empty first segment
 * is never treated as an ancestor.
 */
export function pruneDescendantPaths(paths: readonly string[]): string[] {
  const all = new Set(paths);
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const path of paths) {
    if (emitted.has(path)) continue;
    let hasAncestor = false;
    for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
      if (i > 0 && all.has(path.slice(0, i))) { hasAncestor = true; break; }
    }
    if (hasAncestor) continue;
    emitted.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Delete the viewer's current selection and clear it.
 *
 * Skips the model root and unresolvable paths. When nothing deletable remains
 * nothing is recorded and the selection is LEFT as it was — a Delete press that
 * did nothing must not also silently deselect.
 */
export async function deleteSelectedNodes(viewer: RVViewer, doc: AssetDocument): Promise<void> {
  const selected = viewer.selectionManager.selectedPaths;
  const candidates = selected.filter((path) => {
    const node = viewer.registry?.getNode(path);
    return !!node && !!node.parent && !isModelRoot(node, viewer.currentModelRoot);
  });
  const pruned = pruneDescendantPaths(candidates);
  if (pruned.length === 0) return;
  await doc.deleteNodes(pruned);
  viewer.selectionManager.clear();
}
