// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-import-provider — the STEP provider end to end: real Web Worker + real OCCT WASM,
 * the CADLink extras (content hash of the ORIGINAL file), the source cache behind
 * `retessellate`, registration, the Import-dialog resolve step, and the contract with the
 * core (`AssetDocument.importCad`, CADLink `reimportCad`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box3, Group, Scene, Vector3, type Mesh, type Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { parseGlbSubtree } from '../src/core/engine/rv-glb-parse';
import { cadFormatOfName, getCadProvider, registerCadProvider } from '../src/core/editor/rv-cad-provider';
import { reimportCad } from '../src/core/editor/rv-cadlink-reimport';
import { importProviderRegistry } from '../src/core/import/rv-import-provider';
import { clearCadGlbCache, getCadGlb, sha256Hex } from '../src/core/import/rv-cad-glb-cache';
import {
  convertStepInWorker,
  createStepCadProvider,
  createStepImportProvider,
  importStepFile,
  registerStepImport,
  resolveStepFiles,
} from '../src/plugins/community-editor/step-import';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { assemblyStep, gridAssemblyStep, singlePartStep, stepBytes } from './helpers/step-fixtures';

const machine = (lidHeight = 20) => assemblyStep('Machine', [
  { part: { name: 'Base', geometry: { kind: 'box', size: [200, 100, 50] } }, offset: [0, 0, 0] },
  { part: { name: 'Lid', geometry: { kind: 'box', size: [100, 100, lidHeight] } }, offset: [500, 0, 0] },
]);

const fileOf = (text: string, name: string): File => new File([text], name);

function worldBox(root: Object3D): Box3 {
  root.updateMatrixWorld(true);
  return new Box3().setFromObject(root);
}

function find(root: Object3D, name: string): Object3D {
  let hit: Object3D | undefined;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  if (!hit) throw new Error(`node "${name}" not found`);
  return hit;
}

afterEach(() => {
  registerCadProvider('step', null);
  importProviderRegistry.unregister('step');
});

describe('worker conversion', () => {
  it('converts in a real Web Worker, reports stages, and the GLB is metres / Y-up', async () => {
    const stages: string[] = [];
    const bytes = stepBytes(singlePartStep({ name: 'Cube', geometry: { kind: 'box', size: [100, 100, 100] } })).slice().buffer;
    const { glb, stats } = await convertStepInWorker(bytes, {
      quality: 'standard', rootName: 'Cube', onStage: (s) => stages.push(s),
    });
    expect(stages).toEqual(['loading-engine', 'reading', 'building', 'encoding']);
    expect(stats.meshes).toBe(1);
    expect(bytes.byteLength).toBe(0); // transferred to the worker, not copied
    expect(worldBox(await parseGlbSubtree(glb)).getSize(new Vector3()).x).toBeCloseTo(0.1, 5);
  }, 60_000);

  it('surfaces a conversion error from the worker', async () => {
    const bytes = stepBytes('not a step file').slice().buffer;
    await expect(convertStepInWorker(bytes, { quality: 'standard', rootName: 'x' })).rejects.toThrow(/STEP|geometry/i);
  }, 60_000);

  it('Cancel (AbortSignal) terminates the worker and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const bytes = stepBytes(machine()).slice().buffer;
    const pending = convertStepInWorker(bytes, { quality: 'fine', rootName: 'x', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // An already-aborted signal never even starts a worker.
    await expect(convertStepInWorker(stepBytes('x').slice().buffer, { quality: 'fine', rootName: 'x', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  }, 60_000);

  it('keeps the main thread responsive while OCCT tessellates (no freeze)', async () => {
    const bytes = stepBytes(gridAssemblyStep(120)).slice().buffer;
    let maxGap = 0;
    let ticks = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 20);
    const started = performance.now();
    const { stats } = await convertStepInWorker(bytes, { quality: 'standard', rootName: 'Grid' });
    const took = performance.now() - started;
    clearInterval(timer);

    expect(stats.meshes).toBe(120);
    // Several seconds of OCCT work happened, yet the page's event loop kept ticking.
    expect(took).toBeGreaterThan(500);
    expect(ticks).toBeGreaterThan(took / 100);
    expect(maxGap).toBeLessThan(500);
  }, 120_000);

  it('falls back to the main thread when no worker can be created', async () => {
    const bytes = stepBytes(singlePartStep({ name: 'Cube', geometry: { kind: 'box', size: [10, 10, 10] } })).slice().buffer;
    const { stats } = await convertStepInWorker(bytes, { quality: 'draft', rootName: 'Cube', createWorker: () => null });
    expect(stats.meshes).toBe(1);
  }, 60_000);
});

describe('CadGeometryProvider', () => {
  it('importFile returns GLB bytes and the CADLink extras', async () => {
    const text = machine();
    const provider = createStepCadProvider();
    const { glb, cadlink } = await provider.importFile(fileOf(text, 'machine.stp'), 'Fine');

    expect(new Uint8Array(glb, 0, 4)).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46])); // "glTF"
    expect(cadlink).toEqual({
      File: 'machine.stp',
      Sha256: await sha256Hex(stepBytes(text).slice().buffer),
      Quality: 'fine',
      ImportScaleFactor: 0.001,
      ZIsUpVector: true,
    });
  }, 60_000);

  it('the content hash is stable for identical bytes and changes with the content', async () => {
    const provider = createStepCadProvider();
    const a = await provider.importFile(fileOf(machine(20), 'a.stp'), 'draft');
    const sameBytesOtherName = await provider.importFile(fileOf(machine(20), 'b.step'), 'draft');
    const changed = await provider.importFile(fileOf(machine(30), 'a.stp'), 'draft');
    expect(sameBytesOtherName.cadlink.Sha256).toBe(a.cadlink.Sha256);
    expect(changed.cadlink.Sha256).not.toBe(a.cadlink.Sha256);
  }, 60_000);

  it('normalises the quality id that keys the GLB cache', async () => {
    const { cadlink } = await importStepFile(fileOf(singlePartStep({ name: 'C', geometry: { kind: 'box', size: [1, 1, 1] } }), 'c.stp'), 'bogus');
    expect(cadlink.Quality).toBe('standard');
  }, 60_000);

  it('rejects an empty file', async () => {
    await expect(createStepCadProvider().importFile(new File([], 'empty.stp'), 'standard')).rejects.toThrow(/empty/i);
  });

  it('retessellate rebuilds an evicted GLB from the cached original and re-populates the cache', async () => {
    const provider = createStepCadProvider();
    const { cadlink, glb } = await provider.importFile(fileOf(machine(), 'machine.stp'), 'standard');
    await clearCadGlbCache();
    expect(await getCadGlb(cadlink.Sha256, cadlink.Quality)).toBeNull();

    const rebuilt = await provider.retessellate!(cadlink);
    expect(rebuilt).not.toBeNull();
    expect(new Uint8Array(rebuilt!)).toEqual(new Uint8Array(glb)); // deterministic
    const cached = await getCadGlb(cadlink.Sha256, cadlink.Quality);
    expect(cached).not.toBeNull();
    expect(cached!.byteLength).toBe(glb.byteLength);
    await clearCadGlbCache();
  }, 60_000);

  it('retessellate returns null when the original bytes are gone (caller shows a re-pick prompt)', async () => {
    const provider = createStepCadProvider();
    const unknown = { File: 'x.stp', Sha256: 'ab'.repeat(32), Quality: 'standard', ImportScaleFactor: 0.001, ZIsUpVector: true };
    expect(await provider.retessellate!(unknown)).toBeNull();
  });
});

describe('registerStepImport', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it('registers the CAD provider for "step" and the dialog tab, idempotently', () => {
    expect(getCadProvider('step')).toBeNull();
    registerStepImport();
    registerStepImport();
    expect(getCadProvider(cadFormatOfName('Gearbox.STP'))).not.toBeNull();
    expect(getCadProvider(cadFormatOfName('gearbox.step'))).toBe(getCadProvider('step'));
    expect(getCadProvider('jt')).toBeNull();
    const tab = importProviderRegistry.get('step');
    expect(tab?.label).toBe('STEP');
    expect(tab?.availability()).toBe('ready');
    expect(importProviderRegistry.list().filter((p) => p.id === 'step')).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled(); // no "already registered — replacing"
  });
});

describe('Import dialog resolve step', () => {
  it('turns STEP files into glb items carrying the cadlink; a bad file lands in `failed`', async () => {
    const progress: string[] = [];
    const result = await resolveStepFiles(
      {
        quality: 'draft',
        files: [fileOf(machine(), 'good.step'), fileOf('garbage', 'bad.stp')],
      },
      (p) => progress.push(p.label),
    );
    expect(result.ok).toHaveLength(1);
    const [item] = result.ok;
    expect(item.kind).toBe('glb');
    if (item.kind === 'glb') {
      expect(item.suggestedName).toBe('good');
      expect(item.cadlink).toMatchObject({ File: 'good.step', Quality: 'draft', ImportScaleFactor: 0.001, ZIsUpVector: true });
    }
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('bad.stp');
    expect(progress.some((l) => /Tessellating STEP/.test(l))).toBe(true);
    expect(progress.every((l) => /\(\d\/2\)/.test(l))).toBe(true); // multi-file label carries the position
  }, 120_000);

  it('the tab provider accepts `files` and `custom` input and rejects an empty selection', async () => {
    const tab = createStepImportProvider();
    const empty = await tab.resolve({ kind: 'files', files: [] });
    expect(empty.ok).toHaveLength(0);
    expect(empty.failed).toHaveLength(1);
    const viaFiles = await tab.resolve({
      kind: 'files', files: [fileOf(singlePartStep({ name: 'C', geometry: { kind: 'box', size: [5, 5, 5] } }), 'c.stp')],
    });
    expect(viaFiles.ok).toHaveLength(1);
    const unrelated = await tab.resolve({ kind: 'entries', entries: [] });
    expect(unrelated.failed).toHaveLength(1);
  }, 60_000);

  it('Cancel aborts the whole resolve', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolveStepFiles({ quality: 'draft', files: [fileOf(machine(), 'a.stp')] }, undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('contract with the core editor', () => {
  function world() {
    const scene = new Scene();
    const model = new Group();
    model.name = 'Asset';
    scene.add(model);
    const registry = new NodeRegistry();
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const viewer = {
      scene, registry, signalStore: null, transportManager: null,
      get currentModelRoot() { return model; },
      markRenderDirty() {}, markShadowsDirty() {}, emit() {}, rebuildGroupedBvh() {},
    } as unknown as RVViewer;
    return { viewer, model, registry };
  }

  it('importCad attaches the STEP tree, records the normalisation transform and stamps CADLink', async () => {
    registerStepImport();
    const { viewer, model } = world();
    const doc = scratchAssetDocument(viewer);
    const provider = getCadProvider(cadFormatOfName('machine.stp'))!;
    const result = await provider.importFile(fileOf(machine(), 'machine.stp'), 'standard');

    const rootPath = await doc.importCad(result);
    await doc.whenIdle();

    const root = model.children.find((c) => c.name === 'machine')!;
    expect(rootPath).toBe(NodeRegistry.computeNodePath(root));
    expect(root.scale.x).toBeCloseTo(0.001, 7);
    expect(root.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
    expect((root.userData.realvirtual as { CADLink: { Sha256: string } }).CADLink.Sha256).toBe(result.cadlink.Sha256);
    expect(find(root, 'Lid')).toBeDefined();
    expect(worldBox(find(root, 'Lid')).min.x).toBeCloseTo(0.5, 4);
    doc.dispose();
  }, 60_000);

  it('CADLink re-import of a revised STEP carries the component set up on a part', async () => {
    registerStepImport();
    const { viewer, model } = world();
    const doc = scratchAssetDocument(viewer);
    const provider = getCadProvider('step')!;
    await doc.importCad(await provider.importFile(fileOf(machine(20), 'machine.stp'), 'draft'));
    await doc.whenIdle();

    const root = model.children.find((c) => c.name === 'machine')!;
    const lid = find(root, 'Lid') as Mesh;
    lid.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 100 } };

    // Revision 2: the lid is taller. Same part names -> same name paths.
    const report = await reimportCad(viewer, doc, NodeRegistry.computeNodePath(root),
      fileOf(machine(60), 'machine_v2.stp'), 'draft');
    await doc.whenIdle();

    expect(report.matched).toBe(1);
    expect(report.unmatched).toEqual([]);
    const newRoot = model.children.find((c) => c.name === 'machine')!;
    const newLid = find(newRoot, 'Lid');
    expect((newLid.userData.realvirtual as { Drive: unknown }).Drive).toEqual({ Direction: 'LinearX', TargetSpeed: 100 });
    expect(worldBox(newLid).getSize(new Vector3()).y).toBeCloseTo(0.06, 4); // 60 mm, new revision
    doc.dispose();
  }, 120_000);
});
