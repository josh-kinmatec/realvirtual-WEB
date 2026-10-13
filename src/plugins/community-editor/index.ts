// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * community-editor — a community implementation of the asset-editor WORKSPACE.
 *
 * ## What this is, and what it is not
 *
 * The public core already owns everything that is hard about authoring a GLB: the
 * op-logged `AssetDocument`, its executors, undo/redo, drafts, the one save path
 * (`saveDocument`) and the 58 `web_editor_*` MCP tools. What the core cannot do by
 * itself is START an editing session: nothing in it constructs an `AssetDocument`,
 * registers the `editor` mode, or publishes the active document the MCP tools
 * resolve through `getActiveAssetContext()`. This plugin does exactly that, and
 * nothing more:
 *
 *  - registers the `editor` workspace mode (`runtime: 'detached'` — authoring is
 *    not simulation),
 *  - on activation resolves WHICH document to open (pending request → what the
 *    scene already shows → last edited → a fresh document), loads its bytes into
 *    the viewer as an authoring tree, and publishes the active document,
 *  - installs the drive preview driver the drive gizmo and `web_editor_verify_drive`
 *    need,
 *  - on deactivation tears all of that down and reloads the saved document as a
 *    normal runtime scene.
 *
 * It is MCP-first: there is no editor UI here. The panels, the Materials window and
 * the mesh tools of the commercial editor are not reproduced. Everything an agent
 * needs goes through the MCP tools; a human can watch the viewport while it works.
 *
 * ## Not implemented (and said so)
 *
 * In-place test sessions, descend into referenced assets, crash-recovery of op
 * drafts on re-open, rigid-body mechanisms. Each has a defined seam and degrades to
 * an explicit message rather than a silent no-op.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { ModeId } from '../../core/rv-mode-manager';
import { AssetDocument, type AssetBase } from '../../core/editor/rv-asset-document';
import {
  getOpenDocumentBase,
  setActiveAssetContext,
  setOpenDocumentBase,
} from '../../core/editor/active-asset-store';
import { noteLoadedRevision } from '../../core/editor/rv-save-document';
import { clearDocumentDraft } from '../../core/ops/rv-document-drafts';
import { setDriveDragDriver } from '../../core/engine/drive-drag-driver';
import { setDriveGizmoFallbackResolver } from '../../core/engine/drive-gizmo-source';
import { askUnsavedChoice } from '../../core/hmi/scene/save-dialog-store';
import { getProjectStore } from '../../core/project/project-store';
import { createDocument } from '../../core/project/rv-document-ops';
import { arrayBufferOf } from '../../core/project/rv-scene-record';
import { newDocumentFolderFor, newDocumentNameFor } from '../../core/hmi/projects/dashboard-documents';
import { EDITOR_LAST_ASSET_KEY } from '../../core/hmi/rv-storage-keys';
import { resolveEditorDriveGizmoSource } from '@rv-private/plugins/asset-editor/editor-drive-gizmo-source';
import { editorDriveDragDriver } from './drive-preview-driver';
import { peekPendingAssetOpen, setPendingAssetOpen, takePendingAssetOpen } from './pending-open-store';
import { resolveSelectionToAsset } from './selection-asset-resolver';
import { runSaveFlow } from './save-flow';

/** The id of the mode this plugin owns. */
export const EDITOR_MODE_ID = 'editor';

const LAST_ASSET_VERSION = 1;

// ─── Last edited asset (the open chain's last resort) ─────────────────────

/** Remember the document the editor opened, so a bare "open the editor" can resume it. */
function rememberLastAsset(base: AssetBase): void {
  if (base.kind !== 'document' || !base.path) return;
  try {
    localStorage.setItem(EDITOR_LAST_ASSET_KEY, JSON.stringify({ v: LAST_ASSET_VERSION, base, savedAt: Date.now() }));
  } catch { /* best effort — storage may be unavailable */ }
}

/** The remembered document, or null for any unreadable, foreign or incomplete record. */
function recallLastAsset(): AssetBase | null {
  try {
    const raw = localStorage.getItem(EDITOR_LAST_ASSET_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as { v?: number; base?: Partial<AssetBase> & { kind?: string } };
    if (rec?.v !== LAST_ASSET_VERSION || rec.base?.kind !== 'document') return null;
    const b = rec.base as Extract<AssetBase, { kind: 'document' }>;
    if (!b.documentId || !b.path || !b.name) return null;
    return { kind: 'document', documentId: b.documentId, path: b.path, name: b.name };
  } catch { return null; }
}

// ─── Reading the bytes of a base ──────────────────────────────────────────

interface LoadedBase {
  bytes: ArrayBuffer;
  /** Project-relative path the bytes came from, when they came from the project. */
  path: string | null;
}

/** The bytes a base names, or a sentence saying why they cannot be read. */
async function readBase(base: AssetBase): Promise<LoadedBase | { error: string }> {
  if (base.kind === 'document') {
    if (!base.path) {
      return { error: `"${base.name}" is a scene body, not a file — it cannot be opened in the community editor.` };
    }
    const backend = getProjectStore().getBackend();
    if (!backend) return { error: 'No project is open — open or create one first.' };
    const record = await backend.readDocument(base.path).catch(() => null);
    if (!record?.bytes) return { error: `File not found in the open project: ${base.path}` };
    await noteLoadedRevision(backend, base.path);
    return { bytes: arrayBufferOf(record.bytes), path: base.path };
  }
  if (base.kind === 'builtinModel') {
    const res = await fetch(base.url);
    if (!res.ok) return { error: `Could not fetch ${base.url} (${res.status}).` };
    return { bytes: await res.arrayBuffer(), path: null };
  }
  return { error: `Assets of kind "${base.kind}" cannot be opened in the community editor yet.` };
}

/** Load bytes into the viewer. `authoring` keeps the GLB hierarchy exactly as authored. */
async function loadInto(
  viewer: RVViewer, bytes: ArrayBuffer, name: string, identity: string, authoring: boolean,
): Promise<void> {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  try {
    await viewer.loadModel(url, {
      data: bytes,
      modelName: name,
      identityUrl: identity,
      ...(authoring ? { preserveHierarchy: true, preserveAuthoringHierarchy: true } : {}),
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─── The plugin ───────────────────────────────────────────────────────────

export class CommunityAssetEditorPlugin implements RVViewerPlugin {
  readonly id = 'asset-editor';
  readonly modes: ModeId[] = [EDITOR_MODE_ID];

  private _viewer: RVViewer | null = null;
  /** Bumped on every activation and deactivation: an async continuation of a stale one bails out. */
  private _generation = 0;
  private _doc: AssetDocument | null = null;
  private _base: AssetBase | null = null;
  private readonly _unsubs: Array<() => void> = [];

  init(viewer: RVViewer): void {
    this._viewer = viewer;

    // The editor opens what you were looking at. Resolved on `mode-changing`, which
    // fires BEFORE the old mode's deactivate hook — the planner clears its selection
    // in that hook, so asking later would find nothing.
    this._unsubs.push(viewer.on('mode-changing', ({ to }) => {
      if (to !== EDITOR_MODE_ID) return;
      if (peekPendingAssetOpen()) return;                     // an explicit request always wins
      const path = viewer.selectionManager.primaryPath;
      if (!path) return;
      const base = resolveSelectionToAsset(path);
      if (base) setPendingAssetOpen(base);
    }));

    // Leaving through the UI asks about unsaved work. Programmatic switches
    // (`setMode`, the MCP tools) bypass guards and handle dirtiness themselves.
    this._unsubs.push(viewer.modes.registerExitGuard(EDITOR_MODE_ID, async () => {
      const doc = this._doc;
      if (!doc || !doc.dirty) return true;
      const choice = await askUnsavedChoice(doc.name);
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        const ctx = { viewer, doc };
        return runSaveFlow(ctx);
      }
      await clearDocumentDraft(doc.draftFrame);                // discard
      return true;
    }));
  }

  onModeActivate(_mode: ModeId, viewer: RVViewer): void {
    void this._activate(viewer);
  }

  onModeDeactivate(_mode: ModeId | null, viewer: RVViewer): void {
    this._deactivate(viewer);
  }

  dispose(): void {
    for (const off of this._unsubs.splice(0)) off();
  }

  // ─── activation ─────────────────────────────────────────────────────────

  /** Which document to open: pending request → what the scene shows → last edited → new. */
  private async _resolveTarget(): Promise<AssetBase | { error: string }> {
    const pending = takePendingAssetOpen();
    if (pending) return pending;

    const open = getOpenDocumentBase();
    if (open?.kind === 'document' && open.path) return open;

    const last = recallLastAsset();
    if (last) return last;

    // Nothing to resume: create a real document, exactly as the dashboard's "New"
    // does, so every document has a home before the editor opens it.
    const store = getProjectStore();
    if (!store.getBackend()?.writable) {
      return { error: 'No writable project is open — open or create one before starting the editor.' };
    }
    try {
      const folder = newDocumentFolderFor(store.getProject()?.id, null);
      const target = await createDocument(store, newDocumentNameFor(folder), { folder });
      await store.rescanDocuments?.();
      await store.flush?.();
      return { kind: 'document', documentId: target.documentId, path: target.relPath, name: target.name };
    } catch (e) {
      return { error: `The document could not be created: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async _activate(viewer: RVViewer): Promise<void> {
    const generation = ++this._generation;
    const stale = (): boolean => generation !== this._generation;

    try {
      const target = await this._resolveTarget();
      if (stale()) return;
      if ('error' in target) { console.error(`[community-editor] ${target.error}`); return; }

      const loaded = await readBase(target);
      if (stale()) return;
      if ('error' in loaded) { console.error(`[community-editor] ${loaded.error}`); return; }

      await loadInto(viewer, loaded.bytes, target.kind === 'document' ? target.name : 'asset',
        loaded.path ?? (target.kind === 'builtinModel' ? target.url : target.kind), true);
      if (stale()) return;

      const id = target.kind === 'document' ? target.documentId : `asset-${Date.now().toString(36)}`;
      const name = target.kind === 'document' || target.kind === 'builtinModel' ? target.name : 'Untitled';
      const doc = new AssetDocument(viewer, { id, name, base: target });
      this._doc = doc;
      this._base = target;

      setDriveDragDriver(editorDriveDragDriver);
      setDriveGizmoFallbackResolver((path) => resolveEditorDriveGizmoSource(viewer, path) ?? null);
      setOpenDocumentBase(target);
      rememberLastAsset(target);
      // Published LAST: the MCP tools poll `getActiveAssetContext()` and treat its
      // presence as "the editor is fully ready".
      setActiveAssetContext({ viewer, doc });
    } catch (e) {
      console.error('[community-editor] activation failed:', e);
    }
  }

  // ─── deactivation ───────────────────────────────────────────────────────

  private _deactivate(viewer: RVViewer): void {
    this._generation++;                                        // cancels an activation still loading
    const doc = this._doc;
    const base = this._base;
    this._doc = null;
    this._base = null;

    setActiveAssetContext(null);
    setDriveDragDriver(null);
    setDriveGizmoFallbackResolver(null);
    setOpenDocumentBase(null);
    viewer.selectionManager.clear();
    doc?.dispose();

    // Leave the viewer showing the saved document as a normal runtime scene, so the
    // next mode simulates it. Deferred one tick: when the editor is left only to be
    // re-entered (web_editor_open on another document) the re-entry's own load must
    // win, and starting this one would just be thrown away.
    if (base?.kind === 'document' && base.path) {
      const generation = this._generation;
      setTimeout(() => {
        if (generation !== this._generation) return;
        if (viewer.modes.activeMode === EDITOR_MODE_ID) return;
        void (async () => {
          const loaded = await readBase(base);
          if ('error' in loaded) return;
          if (generation !== this._generation || viewer.modes.activeMode === EDITOR_MODE_ID) return;
          await loadInto(viewer, loaded.bytes, base.name, loaded.path ?? base.name, false);
        })().catch((e) => console.warn('[community-editor] reload after leaving the editor failed:', e));
      }, 0);
    }
  }
}

/**
 * Register the editor workspace and its plugin. Idempotent.
 *
 * Called from the feature-registration hook (`registerPrivatePlugins`) — the one
 * place a licensed build registers the same mode. The descriptor is a flat literal
 * with `runtime: 'detached'` on purpose: `editor-mode-detached.node.test.ts` scans
 * for exactly this shape, because a registration without it silently re-attaches
 * time integration for the whole authoring session.
 */
export function registerCommunityEditor(viewer: RVViewer): void {
  if (viewer.getPlugin('asset-editor')) return;
  viewer.modes.register({ id: 'editor', label: 'Editor', icon: 'Edit', order: 40, runtime: 'detached' });
  viewer.use(new CommunityAssetEditorPlugin());

  // A reload during an editing session must not boot into an editor with nothing to
  // open: the community editor does not resume sessions, so forget that it was active.
  try {
    if (localStorage.getItem('rv-active-mode') === EDITOR_MODE_ID) localStorage.setItem('rv-active-mode', 'hmi');
  } catch { /* best effort */ }
}
