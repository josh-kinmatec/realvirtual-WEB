// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * step-import-core — the STEP -> GLB conversion core (`convertStepToGlb`) driven with the
 * REAL occt-import-js WASM on the main thread (the worker is a thin wrapper around this,
 * see step-import-worker.test.ts).
 *
 * Pins, with hand-written fixtures (tests/helpers/step-fixtures.ts):
 *   - the part / assembly NAMES survive into the GLB hierarchy;
 *   - the geometry is in METRES (a 100 mm box is 0.1 m) and Y-UP (CAD Z becomes world Y);
 *   - colours become materials;
 *   - the GLB parses back with GLTFLoader and through the core's `parseGlbSubtree`;
 *   - the quality presets change the tessellation of curved surfaces;
 *   - unreadable input fails with an actionable message.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Box3, Mesh, SRGBColorSpace, Vector3, type MeshStandardMaterial, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { OcctModule } from 'occt-import-js';
import { parseGlbSubtree } from '../src/core/engine/rv-glb-parse';
import { convertStepToGlb } from '../src/plugins/community-editor/step-import/step-convert';
import { loadOcct } from '../src/plugins/community-editor/step-import/step-occt-loader';
import { stepTessellationParams, normalizeStepQuality } from '../src/plugins/community-editor/step-import/step-quality';
import {
  assemblyStep, singlePartStep, stepBytes,
} from './helpers/step-fixtures';

let occt: OcctModule;

beforeAll(async () => {
  occt = await loadOcct();
}, 60_000);

const convert = (text: string, quality = 'standard', rootName = 'Fixture') =>
  convertStepToGlb(occt, stepBytes(text), { quality, rootName });

function worldBox(root: Object3D): Box3 {
  root.updateMatrixWorld(true);
  return new Box3().setFromObject(root);
}

function find(root: Object3D, name: string): Object3D {
  let hit: Object3D | undefined;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  if (!hit) throw new Error(`node "${name}" not found; have: ${names(root).join(', ')}`);
  return hit;
}

function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out;
}

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((n) => { if ((n as Mesh).isMesh) out.push(n as Mesh); });
  return out;
}

/** Material colour in sRGB (what the user sees), from three's linear working space. */
function srgbOf(material: MeshStandardMaterial): { r: number; g: number; b: number } {
  return material.color.getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
}

describe('single part', () => {
  it('a 100 mm cube is 0.1 m across', async () => {
    const { glb, stats } = await convert(singlePartStep({ name: 'Cube', geometry: { kind: 'box', size: [100, 100, 100] } }));
    expect(stats.meshes).toBe(1);
    expect(stats.triangles).toBe(12);

    const size = worldBox(await parseGlbSubtree(glb)).getSize(new Vector3());
    expect(size.x).toBeCloseTo(0.1, 5);
    expect(size.y).toBeCloseTo(0.1, 5);
    expect(size.z).toBeCloseTo(0.1, 5);
  });

  it('is Y-up: CAD (x, y, z) = (100, 200, 300) mm lands at world (0.1, 0.3, 0.2) m, origin kept', async () => {
    const { glb } = await convert(singlePartStep({ name: 'Slab', geometry: { kind: 'box', size: [100, 200, 300] } }));
    const box = worldBox(await parseGlbSubtree(glb));
    const size = box.getSize(new Vector3());
    // CAD Z (300 mm, "up") becomes world Y; CAD Y (200 mm) becomes world -Z.
    expect(size.x).toBeCloseTo(0.1, 5);
    expect(size.y).toBeCloseTo(0.3, 5);
    expect(size.z).toBeCloseTo(0.2, 5);
    expect(box.min.x).toBeCloseTo(0, 5);
    expect(box.min.y).toBeCloseTo(0, 5); // sits ON the floor, not buried below it
    expect(box.max.z).toBeCloseTo(0, 5);
    expect(box.min.z).toBeCloseTo(-0.2, 5);
  });

  it('records the normalisation on the root transform (scale 0.001, -90 deg about X)', async () => {
    const { glb } = await convert(singlePartStep({ name: 'Cube', geometry: { kind: 'box', size: [10, 10, 10] } }), 'standard', 'MyRoot');
    const root = await parseGlbSubtree(glb);
    expect(root.name).toBe('MyRoot');
    expect(root.scale.x).toBeCloseTo(0.001, 7);
    expect(root.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('keeps the part name when the root would collide with it (no `_1` on the part)', async () => {
    const { glb } = await convert(singlePartStep({ name: 'Cube', geometry: { kind: 'box', size: [10, 10, 10] } }), 'standard', 'Cube');
    const root = await parseGlbSubtree(glb);
    expect(root.name).not.toBe('Cube'); // importCad renames the root to its own unique name anyway
    expect(find(root, 'Cube')).toBeDefined();
    expect(names(root)).not.toContain('Cube_1');
  });

  it('turns the STEP colour into a material colour', async () => {
    const { glb } = await convert(singlePartStep({
      name: 'Orange', geometry: { kind: 'box', size: [10, 10, 10] }, colour: [1, 0.6, 0],
    }));
    const [mesh] = meshes(await parseGlbSubtree(glb));
    // The STEP colour (sRGB 1, 0.6, 0) survives: three holds it linear, glTF stores it linear.
    const srgb = srgbOf(mesh.material as MeshStandardMaterial);
    expect(srgb.r).toBeCloseTo(1, 2);
    expect(srgb.g).toBeCloseTo(0.6, 2);
    expect(srgb.b).toBeCloseTo(0, 2);
  });

  it('parses back with a plain GLTFLoader (valid GLB)', async () => {
    const { glb } = await convert(singlePartStep({ name: 'Cube', geometry: { kind: 'box', size: [10, 10, 10] } }));
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    expect(meshes(gltf.scene)).toHaveLength(1);
    expect(names(gltf.scene)).toContain('Cube');
  });
});

describe('assembly', () => {
  const text = assemblyStep('Machine', [
    { part: { name: 'Base', geometry: { kind: 'box', size: [200, 100, 50] }, colour: [0.2, 0.4, 0.8] }, offset: [0, 0, 0] },
    { part: { name: 'Lid', geometry: { kind: 'box', size: [100, 100, 20] } }, offset: [500, 0, 0] },
    { part: { name: 'Pin', geometry: { kind: 'cylinder', radius: 10, height: 80 } }, offset: [0, 300, 0] },
  ]);

  it('keeps the assembly structure and the part names', async () => {
    const { glb, stats } = await convert(text, 'standard', 'Machine.stp');
    const root = await parseGlbSubtree(glb);
    expect(stats.meshes).toBe(3);

    // root > top-level product > parts (one mesh per part, named after the part)
    expect(root.name).toBe('Machine.stp');
    const machine = find(root, 'Machine');
    expect(machine.parent).toBe(root);
    for (const part of ['Base', 'Lid', 'Pin']) {
      const node = find(root, part);
      expect(node.parent).toBe(machine);
      expect((node as Mesh).isMesh).toBe(true);
    }
  });

  it('places every part where the assembly puts it, in metres, Y-up', async () => {
    const { glb } = await convert(text);
    const root = await parseGlbSubtree(glb);
    const lid = worldBox(find(root, 'Lid'));
    // Lid: 100 x 100 x 20 mm at x = 500 mm -> x in [0.5, 0.6] m, height 0.02 m.
    expect(lid.min.x).toBeCloseTo(0.5, 4);
    expect(lid.max.x).toBeCloseTo(0.6, 4);
    expect(lid.getSize(new Vector3()).y).toBeCloseTo(0.02, 4);
    // Pin sits at CAD y = 300 mm -> world z = -0.3 m (Y-up), 80 mm tall.
    const pin = worldBox(find(root, 'Pin'));
    expect(pin.getSize(new Vector3()).y).toBeCloseTo(0.08, 4);
    expect((pin.min.z + pin.max.z) / 2).toBeCloseTo(-0.3, 3);

    const all = worldBox(root);
    expect(all.max.x).toBeCloseTo(0.6, 4);
  });

  it('gives each distinct colour its own material and shares it between parts', async () => {
    const { glb } = await convert(text);
    const root = await parseGlbSubtree(glb);
    const base = (find(root, 'Base') as Mesh).material as MeshStandardMaterial;
    const lid = (find(root, 'Lid') as Mesh).material as MeshStandardMaterial;
    expect(srgbOf(base).b).toBeCloseTo(0.8, 2);
    expect(srgbOf(lid).r).toBeCloseTo(0.7, 2); // uncoloured -> default grey (sRGB 0.7)
    expect(lid).not.toBe(base);
  });
});

describe('quality presets', () => {
  const cylinder = singlePartStep({ name: 'Pin', geometry: { kind: 'cylinder', radius: 25, height: 100 } });

  it('maps ids to presets (unknown ids -> standard)', () => {
    expect(normalizeStepQuality('Draft')).toBe('draft');
    expect(normalizeStepQuality('coarse')).toBe('draft');
    expect(normalizeStepQuality('fine')).toBe('fine');
    expect(normalizeStepQuality('standard')).toBe('standard');
    expect(normalizeStepQuality('bogus')).toBe('standard');
    expect(normalizeStepQuality(undefined)).toBe('standard');
    const draft = stepTessellationParams('draft');
    const fine = stepTessellationParams('fine');
    expect(draft.linearDeflection).toBeGreaterThan(fine.linearDeflection);
    expect(draft.angularDeflection).toBeGreaterThan(fine.angularDeflection);
    expect(stepTessellationParams('standard')).toMatchObject({ linearUnit: 'millimeter', linearDeflection: 0.001, angularDeflection: 0.5 });
  });

  it('draft < standard < fine in triangle count on a curved part', async () => {
    const draft = (await convert(cylinder, 'draft')).stats.triangles;
    const standard = (await convert(cylinder, 'standard')).stats.triangles;
    const fine = (await convert(cylinder, 'fine')).stats.triangles;
    expect(draft).toBeLessThan(standard);
    expect(standard).toBeLessThan(fine);
  });

  it('is deterministic: the same input and quality give identical GLB bytes', async () => {
    const a = (await convert(cylinder, 'standard')).glb;
    const b = (await convert(cylinder, 'standard')).glb;
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
  });
});

describe('failure modes', () => {
  it('rejects bytes that are not STEP, with an actionable message', async () => {
    await expect(convertStepToGlb(occt, stepBytes('this is not a STEP file'), { quality: 'standard', rootName: 'x' }))
      .rejects.toThrow(/could not be read as STEP|no geometry/i);
  });

  it('rejects a STEP file without any geometry', async () => {
    const empty = singlePartStep({ name: 'Cube', geometry: { kind: 'box', size: [1, 1, 1] } })
      .replace(/MANIFOLD_SOLID_BREP/, 'MANIFOLD_SOLID_BREP_BROKEN');
    await expect(convertStepToGlb(occt, stepBytes(empty), { quality: 'standard', rootName: 'x' }))
      .rejects.toThrow(/STEP|geometry/i);
  });

  it('reports stage timings and sizes', async () => {
    const stages: string[] = [];
    const { stats } = await convertStepToGlb(
      occt,
      stepBytes(singlePartStep({ name: 'Cube', geometry: { kind: 'box', size: [10, 10, 10] } })),
      { quality: 'standard', rootName: 'x', onStage: (s) => stages.push(s) },
    );
    expect(stages).toEqual(['reading', 'building', 'encoding']);
    expect(stats.glbBytes).toBeGreaterThan(100);
    expect(stats.nodes).toBeGreaterThanOrEqual(2);
  });
});

