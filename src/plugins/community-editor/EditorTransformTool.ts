// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * EditorTransformTool — binds the reusable core {@link TransformGizmo} to the
 * editor selection and to the AssetDocument.
 *
 * The gizmo owns the drag gesture and writes the live pose straight onto the
 * dragged nodes (so the viewport follows the pointer). This tool owns the rest:
 *
 *  - which nodes the gizmo attaches to — the selection, minus the asset root
 *    (its pose is the asset origin and is locked) and minus nodes that lie below
 *    another selected node (they travel with their ancestor, and moving both
 *    would move the descendant twice);
 *  - persistence — the pose a drag started from is snapshotted, and on release
 *    ONE `transformNode` per moved node is recorded, all in one transaction, so
 *    a drag is a single undo step. A click without motion records nothing.
 *
 * The tool is passive until {@link install}; {@link uninstall} detaches the
 * gizmo and drops the selection subscription. Call {@link update} once per
 * rendered frame so the gizmo keeps its screen-constant size and follows
 * external moves (undo/redo, inspector edits).
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { AssetDocument } from '../../core/editor/rv-asset-document';
import type { NodeTransform } from '../../core/editor/rv-asset-ops';
import { TransformGizmo, type GizmoPivotMode } from '../../core/engine/rv-transform-gizmo';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { isModelRoot } from '../../core/engine/rv-model-root';
import { pruneDescendantPaths } from './delete-selection';

export class EditorTransformTool {
  private gizmo: TransformGizmo | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Local TRS of each dragged node at drag start — the `prev` of its op. */
  private readonly dragStart = new Map<Object3D, NodeTransform>();

  constructor(
    private readonly viewer: RVViewer,
    private readonly doc: AssetDocument,
  ) {}

  /** Create the gizmo and start following the selection. Idempotent. */
  install(): void {
    if (this.gizmo) return;
    this.gizmo = new TransformGizmo(this.viewer, {
      onDragStart: (nodes) => this.onDragStart(nodes),
      onDragEnd: (nodes, moved) => this.onDragEnd(nodes, moved),
    });
    this.unsubscribe = this.viewer.selectionManager.subscribe(() => this.syncToSelection());
    this.syncToSelection();
  }

  /** Detach and dispose the gizmo; stop following the selection. */
  uninstall(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.gizmo?.dispose();
    this.gizmo = null;
    this.dragStart.clear();
  }

  /** Per-frame hook: screen-constant scale + follow external node moves. */
  update(): void {
    this.gizmo?.update();
  }

  /** Re-derive the attached nodes from the current selection. */
  refresh(): void {
    this.syncToSelection();
  }

  /** True while the gizmo is dragged or hovered — selection/marquee must stand down. */
  get isEngaged(): boolean {
    return this.gizmo?.isEngaged ?? false;
  }

  /** Gizmo anchor: node origin (`pivot`) or the selection's bounds center. */
  get pivotMode(): GizmoPivotMode {
    return this.gizmo?.pivotMode ?? 'pivot';
  }
  set pivotMode(mode: GizmoPivotMode) {
    if (this.gizmo) this.gizmo.pivotMode = mode;
  }

  // ─── Selection → gizmo ────────────────────────────────────────────────

  private attachableNodes(): Object3D[] {
    const viewer = this.viewer;
    const root = viewer.currentModelRoot;
    const resolvable = viewer.selectionManager.selectedPaths.filter((path) => {
      const node = viewer.registry?.getNode(path);
      return !!node && !isModelRoot(node, root);
    });
    const nodes: Object3D[] = [];
    for (const path of pruneDescendantPaths(resolvable)) {
      const node = viewer.registry?.getNode(path);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  private syncToSelection(): void {
    const gizmo = this.gizmo;
    if (!gizmo) return;
    // Never re-attach under a running drag — attach() ends it.
    if (gizmo.isDragging) return;
    const nodes = this.attachableNodes();
    if (nodes.length === 0) gizmo.detach();
    else gizmo.attach(nodes);
  }

  // ─── Drag → op log ────────────────────────────────────────────────────

  private static snapshot(node: Object3D): NodeTransform {
    return {
      position: node.position.toArray() as [number, number, number],
      quaternion: node.quaternion.toArray() as [number, number, number, number],
      scale: node.scale.toArray() as [number, number, number],
    };
  }

  private onDragStart(nodes: readonly Object3D[]): void {
    this.dragStart.clear();
    // The gizmo already made every local transform writable (unfrozen) before this.
    for (const node of nodes) this.dragStart.set(node, EditorTransformTool.snapshot(node));
  }

  private onDragEnd(nodes: readonly Object3D[], moved: boolean): void {
    const starts = new Map(this.dragStart);
    this.dragStart.clear();
    if (!moved) return;

    const edits: Array<{ path: string; next: NodeTransform; prev: NodeTransform }> = [];
    for (const node of nodes) {
      const prev = starts.get(node);
      if (!prev) continue;
      const path = this.viewer.registry?.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
      edits.push({ path, next: EditorTransformTool.snapshot(node), prev });
    }
    if (edits.length === 0) return;

    const label = edits.length === 1 ? `Move ${nodes[0]?.name || 'object'}` : `Move ${edits.length} objects`;
    void this.doc.withTransaction(label, async () => {
      for (const e of edits) this.doc.transformNode(e.path, e.next, e.prev);
    }).catch((err) => console.warn('[EditorTransformTool] could not record the move:', err));
  }
}
