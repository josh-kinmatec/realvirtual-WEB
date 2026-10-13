// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-community-e2e.test.ts — community physics (Rapier provider +
 * PhysicsZonePlugin) end to end against REAL Rapier WASM and the REAL
 * transport manager: kinematic belt -> handover at the belt end -> fall ->
 * land on a kinematic belt -> settle -> return to the kinematic pipeline, and a
 * physics-managed belt carrying an MU off its end onto the synthetic floor.
 *
 * Imports the community modules by relative path, so it also runs in the
 * community build. Skips gracefully when the out-of-band Rapier package is
 * missing (the plugin then stays kinematic).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Box3, Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { EventEmitter } from '../src/core/rv-events';
import { physicsDiagnostics, physicsRegistry, physicsSettings } from '../src/core/engine/rv-physics-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { PhysicsZonePlugin } from '../src/plugins/community-physics/physics-zone-plugin';
import { registerCommunityPhysics } from '../src/plugins/community-physics';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const DT = 1 / 60;

function createMU(x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = 'part';
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
}

function createSurface(
  x: number, y: number, z: number, half: Vector3, speed: number, name: string,
): RVTransportSurface {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, half));
  surface.TransportDirection.set(1, 0, 0);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as unknown as RVTransportSurface['drive'];
  return surface;
}

function createZone(center: [number, number, number], size: [number, number, number]): RVPhysicsZone {
  const node = new Object3D();
  node.name = 'Zone';
  node.position.set(...center);
  node.updateMatrixWorld(true);
  const zone = new RVPhysicsZone(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: size[0], y: size[1], z: size[2] }));
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
  return zone;
}

function setup(boundingBox: Box3): { tm: RVTransportManager; plugin: PhysicsZonePlugin; viewer: RVViewer; result: LoadResult } {
  const tm = new RVTransportManager();
  tm.scene = new Scene();
  const emitter = new EventEmitter();
  const viewer = {
    transportManager: tm,
    registry: { getNode: () => null },
    gizmoManager: undefined,
    simulationKernel: null,
    getPlugin: () => undefined,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as RVViewer;
  const result = {
    root: new Object3D(),
    boundingBox,
    transportManager: tm,
    registry: { getNode: () => null },
    drives: [],
  } as unknown as LoadResult;
  return { tm, plugin: new PhysicsZonePlugin(), viewer, result };
}

function run(tm: RVTransportManager, plugin: PhysicsZonePlugin, seconds: number, until?: () => boolean): void {
  const ticks = Math.round(seconds * 60);
  for (let t = 0; t < ticks; t++) {
    tm.update(DT);
    plugin.onFixedUpdatePost(DT);
    if (until?.()) return;
  }
}

beforeEach(() => {
  RVPhysicsZone.clearAll();
  RVTransportSurface.physicsDefault = true;
  physicsRegistry.register(null); // the plugin creates the Rapier provider lazily
  physicsSettings.enabled = true;
  physicsSettings.full = false;
});

afterEach(() => {
  RVPhysicsZone.clearAll();
  RVTransportSurface.physicsDefault = true;
  physicsRegistry.register(null);
  physicsSettings.enabled = false;
  physicsSettings.full = false;
});

describe('community physics end to end (real Rapier, real transport manager)', () => {
  it('belt end, free fall, landing on a lower kinematic belt, settle, return to kinematic transport', async () => {
    const { tm, plugin, viewer, result } = setup(new Box3(new Vector3(-3, -1, -3), new Vector3(6, 3, 3)));
    const upper = createSurface(0, 1, 0, new Vector3(1, 0.05, 0.5), 500, 'Upper'); // top y = 1.05, +0.5 m/s
    const lower = createSurface(2.13, 0.6, 0, new Vector3(1, 0.05, 0.5), 0, 'Lower'); // x 1.13..3.13, top y = 0.65, stopped
    tm.surfaces.push(upper, lower);
    createZone([1.5, 0.5, 0], [8, 4, 4]);

    plugin.onModelLoaded(result, viewer);
    await plugin.buildPromise;
    if (!physicsRegistry.provider?.ready) {
      console.warn('[physics e2e] Rapier not installed - skipping');
      plugin.dispose();
      return;
    }
    expect(physicsDiagnostics.active).toBe(true);

    const mu = createMU(-0.5, 1.1, 0);
    tm.mus.push(mu);

    let handedOver = false;
    run(tm, plugin, 6, () => {
      if (mu.physicsOwned) handedOver = true;
      return handedOver && !mu.physicsOwned; // handed over AND returned
    });

    const p = mu.getPosition();
    const q = mu.getQuaternion();
    console.log(`[physics e2e] end state owned=${mu.physicsOwned} pos=(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}) quat=(${q.x.toFixed(3)}, ${q.y.toFixed(3)}, ${q.z.toFixed(3)}, ${q.w.toFixed(3)})`);
    expect(handedOver).toBe(true);
    expect(mu.physicsOwned).toBe(false);          // settled upright on a kinematic belt -> returned
    expect(mu.physicsBodyId).toBeNull();
    expect(p.x).toBeGreaterThan(1.13);             // on the lower belt (x 1.13..3.13)
    expect(p.x).toBeLessThan(3.13);
    expect(p.y).toBeGreaterThan(0.68);             // resting on the lower belt top (0.65) + half 0.05
    expect(p.y).toBeLessThan(0.74);

    plugin.dispose();
    expect(physicsDiagnostics.active).toBe(false);
    expect(physicsRegistry.provider).toBeNull(); // the lazily created provider is unregistered again
  }, 30000);

  it('physics-managed belt carries the MU, it drops off the end and rests on the synthetic floor', async () => {
    const { tm, plugin, viewer, result } = setup(new Box3(new Vector3(-3, 0, -3), new Vector3(6, 3, 3)));
    const belt = createSurface(0, 0.5, 0, new Vector3(1, 0.05, 0.5), 1000, 'PhysBelt'); // top y = 0.55
    belt.PhysicsMode = true;
    tm.surfaces.push(belt);
    // No authored zone -> synthetic WholeScene zone (+ floor plate at y = 0).

    plugin.onModelLoaded(result, viewer);
    await plugin.buildPromise;
    if (!physicsRegistry.provider?.ready) {
      console.warn('[physics e2e] Rapier not installed - skipping');
      plugin.dispose();
      return;
    }
    expect(tm.physicsManagedSurfaces?.has(belt)).toBe(true);

    const mu = createMU(-0.8, 0.6, 0);
    tm.mus.push(mu);
    run(tm, plugin, 1.0);
    expect(mu.physicsOwned).toBe(true);
    const onBeltX = mu.getPosition().x;
    expect(onBeltX).toBeGreaterThan(-0.8 + 0.3); // carried by the belt (friction take-along)

    run(tm, plugin, 5);
    const p = mu.getPosition();
    expect(p.x).toBeGreaterThan(1.0);            // left the belt
    expect(p.y).toBeGreaterThan(0.03);           // rests on the floor plate (top y = 0) + half extent
    expect(p.y).toBeLessThan(0.09);
    expect(mu.physicsOwned).toBe(true);          // no kinematic surface underneath -> stays physics-owned
    console.log(`[physics e2e] rests at (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}), carried to x=${onBeltX.toFixed(2)} after 1 s`);

    plugin.dispose();
  }, 30000);

  it('registerCommunityPhysics is idempotent and registers the plugin once', () => {
    const plugins: Array<{ id: string }> = [];
    const viewer = {
      getPlugin: (id: string) => plugins.find((p) => p.id === id),
      use: (p: { id: string }) => { plugins.push(p); return viewer; },
    } as unknown as RVViewer;
    registerCommunityPhysics(viewer);
    registerCommunityPhysics(viewer);
    expect(plugins.map((p) => p.id)).toEqual(['physics-zone']);
  });
});
