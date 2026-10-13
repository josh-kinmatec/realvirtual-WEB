// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * physics-zone-plugin.ts — lifecycle owner of the optional zone-based physics
 * (community edition; the public core only ships the contract and registry in
 * `core/engine/rv-physics-registry.ts` / `rv-physics-zone.ts`).
 *
 * What it does
 * ------------
 *  - **World build per model load** (`onModelLoaded`): only when the load-time
 *    gate `physicsSettings.enabled` is on. Zones come from the model's
 *    `RVPhysicsZone` components; with the toggle on and no authored zone (or
 *    `physicsSettings.full`) a synthetic WholeScene zone from the scene bounds
 *    is added (F16/F17) together with an invisible floor plate. Static
 *    colliders: the zones' `StaticColliders` node paths plus implicit boxes
 *    (BoxCollider nodes inside a zone that carry no simulation component),
 *    protected by the visibility / activeSelf / degenerate / oversize guards.
 *    Transport surfaces with `PhysicsMode` (or all non-radial ones in full
 *    mode) that lie FULLY inside a zone become kinematic conveyor bodies;
 *    `PhysicsMode` sensors become sensor colliders / physics ray casts and
 *    sinks inside a zone get an event-based consumption collider.
 *  - **Per tick** (`onFixedUpdatePost`, i.e. AFTER `transportManager.update`):
 *    adopt MUs the transport manager handed over, feed the conveyor
 *    velocities, step the provider, read the poses back into the MU nodes /
 *    instance pools (second `updatePoolMatrices()` so instanced MUs render this
 *    tick's pose), evaluate sensors, apply `RemoveBelowY` and return settled,
 *    upright MUs lying on a KINEMATIC surface to the kinematic pipeline.
 *  - **Reset chokepoint**: registers itself as `transportManager.physicsMUHook`
 *    so every MU dispose path frees its body first (F14).
 *  - **Guards**: physics never runs in DES mode (world torn down on the switch,
 *    rebuilt when continuous mode returns) and never while a multiuser session
 *    is connected (Unity is the pose authority, F12). A provider that failed
 *    off (`failed`) is torn down and its MUs go back to the kinematic pipeline.
 *
 * Choices the repo does not pin down (documented guesses): the settle-return
 * tolerance (MU bottom within `RETURN_SURFACE_TOLERANCE` of a kinematic
 * surface top), the conveyor body is the surface's world AABB (no rotated
 * belts), and "live connection" is read as the multiuser plugin's connection.
 */

import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { RVViewer } from '../../core/rv-viewer';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { IMUAccessor, InstancedMovingUnit, RVMovingUnit } from '../../core/engine/rv-mu';
import type { RVSensor } from '../../core/engine/rv-sensor';
import type { RVSink } from '../../core/engine/rv-sink';
import type { RVTransportManager } from '../../core/engine/rv-transport-manager';
import { AABB } from '../../core/engine/rv-aabb';
import { RVPhysicsZone } from '../../core/engine/rv-physics-zone';
import { RVTransportSurface } from '../../core/engine/rv-transport-surface';
import { MM_TO_METERS } from '../../core/engine/rv-constants';
import { unityPositionToGltf } from '../../core/engine/rv-coordinate-utils';
import {
  physicsDiagnostics,
  physicsRegistry,
  physicsSettings,
  type IPhysicsMUHook,
  type PhysicsAABB,
  type PhysicsProvider,
  type PhysicsQuat,
  type PhysicsVec3,
} from '../../core/engine/rv-physics-registry';
import {
  PHYSICS_FLOOR_MARGIN,
  PHYSICS_FLOOR_THICKNESS,
  PHYSICS_SCENE_AXIS_EPSILON,
  PHYSICS_SETTLE_LIN_VEL,
  PHYSICS_STATIC_BOX_MAX_SCENE_FRACTION,
  PHYSICS_UPRIGHT_TOLERANCE_DEG,
} from '../../core/engine/rv-physics-constants';

type AnyMU = RVMovingUnit | InstancedMovingUnit;

/** Plugin id (also the key of the idempotent registration). */
export const PHYSICS_ZONE_PLUGIN_ID = 'physics-zone';

/** Max vertical gap (m) between a settled MU's bottom and a kinematic surface top. */
const RETURN_SURFACE_TOLERANCE = 0.02;

const Q_IDENTITY: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };

/** `userData.realvirtual` keys that mark a node as part of the simulation. */
const SIMULATION_KEYS: ReadonlySet<string> = new Set([
  'TransportSurface', 'Sensor', 'WebSensor', 'Sink', 'Source', 'Grip', 'GripTarget',
  'WebPhysicsZone', 'Path', 'Conveyor', 'Turntable', 'ChainTransfer', 'OverheadConveyor', 'Agv',
]);

// ─── Pure helpers ───────────────────────────────────────────────────────────

interface WorldBox {
  center: Vector3;
  half: Vector3;
  quat: Quaternion;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec3(v: unknown): v is { x: number; y: number; z: number } {
  if (!v || typeof v !== 'object') return false;
  const o = v as { x?: unknown; y?: unknown; z?: unknown };
  return isFiniteNumber(o.x) && isFiniteNumber(o.y) && isFiniteNumber(o.z);
}

interface RawBox { center: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } }

/** A box definition is usable when center is finite and EVERY size component is finite and > 0. */
function validRawBox(raw: unknown): RawBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { center?: unknown; size?: unknown };
  if (!isVec3(o.center) || !isVec3(o.size)) return null;
  if (o.size.x <= 0 || o.size.y <= 0 || o.size.z <= 0) return null;
  return { center: o.center, size: o.size };
}

/** First VALID box definition of a node: legacy `BoxCollider` key, then `colliders[]` entries. */
function firstValidBox(rv: Record<string, unknown>): RawBox | null {
  const legacy = validRawBox(rv['BoxCollider']);
  if (legacy) return legacy;
  const colliders = rv['colliders'];
  if (Array.isArray(colliders)) {
    for (const col of colliders) {
      const entry = col as { type?: unknown };
      if (entry && (entry.type === 'Box' || entry.type === 'BoxCollider')) {
        const box = validRawBox(col);
        if (box) return box;
      }
    }
  }
  return null;
}

const _scratchMat = new Matrix4();

/** Tight axis-aligned half extents of a box with LOCAL half extents rotated by `q`. */
function envelopeHalf(q: Quaternion, half: Vector3, out: Vector3): Vector3 {
  const e = _scratchMat.makeRotationFromQuaternion(q).elements;
  return out.set(
    Math.abs(e[0]) * half.x + Math.abs(e[4]) * half.y + Math.abs(e[8]) * half.z,
    Math.abs(e[1]) * half.x + Math.abs(e[5]) * half.y + Math.abs(e[9]) * half.z,
    Math.abs(e[2]) * half.x + Math.abs(e[6]) * half.y + Math.abs(e[10]) * half.z,
  );
}

/** World oriented box of a node's authored BoxCollider data (extras center/size → glTF space). */
function worldBoxOf(node: Object3D, raw: RawBox, out: WorldBox): void {
  node.updateWorldMatrix(true, false);
  const g = unityPositionToGltf(raw.center.x, raw.center.y, raw.center.z);
  out.center.copy(g).applyMatrix4(node.matrixWorld);
  node.getWorldQuaternion(out.quat);
  node.getWorldScale(_scratchScale);
  out.half.set(
    (Math.abs(raw.size.x) / 2) * Math.abs(_scratchScale.x),
    (Math.abs(raw.size.y) / 2) * Math.abs(_scratchScale.y),
    (Math.abs(raw.size.z) / 2) * Math.abs(_scratchScale.z),
  );
}
const _scratchScale = new Vector3();

function toQuat(q: Quaternion): PhysicsQuat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function toVec(v: Vector3): PhysicsVec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function aabbOverlap(a: PhysicsAABB, b: PhysicsAABB): boolean {
  return (
    a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z
  );
}

// ─── Bookkeeping records ────────────────────────────────────────────────────

interface ConveyorEntry { id: string; surface: RVTransportSurface }

interface ManagedSensor {
  id: string;
  sensor: RVSensor;
  raycast: boolean;
  /** MU ids currently inside the sensor volume (collision mode). */
  present: Set<string>;
}

interface ZoneLimit {
  min: PhysicsVec3;
  max: PhysicsVec3;
  removeBelowY: number;
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

export class PhysicsZonePlugin implements RVViewerPlugin, IPhysicsMUHook {
  readonly id = PHYSICS_ZONE_PLUGIN_ID;
  /** Early in the POST stage so other POST plugins see this tick's sensor state. */
  readonly order = 20;
  /** Infrastructure: must also run when a model declares a selective `rv_plugins` list. */
  readonly core = true;

  /** Resolves when the async world build finished; `null` while the gate is closed. */
  buildPromise: Promise<void> | null = null;

  private _viewer: RVViewer | null = null;
  private _result: LoadResult | null = null;
  private _tm: RVTransportManager | null = null;
  private _simMode: string = 'continuous';
  private _unsubs: Array<() => void> = [];
  private _subscribedTo: RVViewer | null = null;

  /** Bumped on every teardown: lets an async build detect that it is stale. */
  private _gen = 0;
  private _building = false;
  private _active = false;

  private _provider: PhysicsProvider | null = null;
  private _createdProvider = false;
  /** True between acquiring the provider and its `dispose()` (no double dispose). */
  private _providerLive = false;
  private _syntheticZone: RVPhysicsZone | null = null;

  /** bodyId (`String(mu.id)`) → MU for every MU the provider owns. */
  private readonly _bodies = new Map<string, AnyMU>();
  private _conveyors: ConveyorEntry[] = [];
  private _managedSurfaces: Set<RVTransportSurface> | null = null;
  private _managedSensorSet: Set<RVSensor> | null = null;
  private _managedSensors: ManagedSensor[] = [];
  private readonly _sensorById = new Map<string, ManagedSensor>();
  private readonly _sinkById = new Map<string, RVSink>();
  private _zoneLimits: ZoneLimit[] = [];
  private _minRemoveBelowY = -Infinity;

  /** One warning per node (uuid) / path per model — reset on `onModelCleared`. */
  private readonly _warned = new Set<string>();

  // ── Reused scratch (zero-GC per tick) ─────────────────────────────────────
  private readonly _vel = new Vector3();
  private readonly _dir = new Vector3();
  private readonly _rayOrigin = new Vector3();
  private readonly _rayDir = new Vector3();
  private readonly _poseVec = new Vector3();
  private readonly _poseQuat = new Quaternion();
  private _instancedDirty = false;

  private readonly _applyPose = (muId: string, pos: PhysicsVec3, quat: PhysicsQuat): void => {
    const mu = this._bodies.get(muId);
    if (!mu || mu.markedForRemoval) return;
    // RemoveBelowY (F9): flag only — the transport manager removes the MU on its
    // next tick through the chokepoint hook, which frees the body.
    if (pos.y < this._removeBelowFor(pos.x, pos.y, pos.z)) {
      mu.markedForRemoval = true;
      return;
    }
    mu.setPosition(this._poseVec.set(pos.x, pos.y, pos.z));
    mu.setQuaternion(this._poseQuat.set(quat.x, quat.y, quat.z, quat.w));
    mu.updateAABB();
    if (mu.isInstanced) this._instancedDirty = true;
  };

  private readonly _onSensorEvent = (sensorId: string, muId: string, entered: boolean): void => {
    const managed = this._sensorById.get(sensorId);
    if (managed) {
      if (entered) managed.present.add(muId);
      else managed.present.delete(muId);
      return;
    }
    // Zone sink: the enter event consumes the physics MU (idempotent).
    const sink = this._sinkById.get(sensorId);
    if (sink && entered && sink.isOwner) {
      const mu = this._bodies.get(muId);
      if (mu && !mu.markedForRemoval) {
        mu.markedForRemoval = true;
        sink.onConsumed?.(mu, sink);
      }
    }
  };

  // ═══ Plugin lifecycle ═════════════════════════════════════════════════════

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    if (this._result && this._result !== result) this._teardown();
    this._viewer = viewer;
    this._result = result;
    this._tm = result.transportManager;
    this._simMode = viewer.simulationKernel?.mode ?? 'continuous';
    this._subscribe(viewer);
    this._reevaluate();
  }

  onModelCleared(_viewer: RVViewer): void {
    this._teardown();
    // `RVPhysicsZone.zones` is a static collection and components have no
    // reliable per-instance dispose on model switches — clear it here.
    RVPhysicsZone.clearAll();
    this._syntheticZone = null;
    this._warned.clear();
    this._result = null;
    this._tm = null;
    this.buildPromise = null;
  }

  /** User switched the plugin off (feature matrix) — keep the zones, drop the world. */
  onDeactivate(_viewer: RVViewer): void {
    this._teardown();
  }

  /** User switched the plugin back on. */
  onActivate(_viewer: RVViewer): void {
    this._reevaluate();
  }

  onFixedUpdatePost(dt: number): void {
    if (!this._active) return;
    const provider = this._provider;
    const tm = this._tm;
    if (!provider || !tm) return;
    if (provider.failed) {
      // Fail-off latch: MUs go back to the kinematic pipeline, world is freed.
      this._teardown();
      return;
    }
    if (!provider.ready) return;

    const t0 = performance.now();
    this._adopt(tm);
    this._feedConveyors(provider);

    provider.step(dt);

    this._instancedDirty = false;
    provider.syncPoses(this._applyPose);
    // The regular updatePoolMatrices() ran inside transport.update BEFORE this
    // hook — recompose the instance matrices so instanced MUs show this tick's pose.
    if (this._instancedDirty) tm.updatePoolMatrices();

    this._evaluateSensors(provider);
    this._returnSettled(provider, tm);

    physicsDiagnostics.bodies = this._bodies.size;
    physicsDiagnostics.stepMs = performance.now() - t0;
  }

  dispose(): void {
    this._teardown();
    this._unsubscribe();
    if (this._createdProvider && physicsRegistry.provider === this._provider) physicsRegistry.register(null);
    this._createdProvider = false;
    this._provider = null;
    this._viewer = null;
    this._result = null;
    this._tm = null;
  }

  // ═══ IPhysicsMUHook ═══════════════════════════════════════════════════════

  onMUDisposed(mu: IMUAccessor): void {
    const id = mu.physicsBodyId;
    if (id !== null) {
      this._provider?.removeBody(id);
      this._bodies.delete(id);
      this._dropPresence(id);
    }
    mu.physicsBodyId = null;
    mu.physicsOwned = false;
  }

  // ═══ Gate / events ════════════════════════════════════════════════════════

  private _subscribe(viewer: RVViewer): void {
    if (this._subscribedTo === viewer) return;
    this._unsubscribe();
    this._subscribedTo = viewer;
    this._unsubs.push(
      viewer.on('simulation-mode-changed', (data) => {
        const mode = (data as { mode?: string } | undefined)?.mode;
        if (typeof mode === 'string') this._simMode = mode;
        this._reevaluate();
      }),
      viewer.on('multiuser-changed', () => this._reevaluate()),
    );
  }

  private _unsubscribe(): void {
    for (const off of this._unsubs) off();
    this._unsubs = [];
    this._subscribedTo = null;
  }

  private _multiuserConnected(): boolean {
    const mu = this._viewer?.getPlugin('multiuser') as unknown as { isConnected?: boolean } | undefined;
    return mu?.isConnected === true;
  }

  private _shouldRun(): boolean {
    return (
      physicsSettings.enabled &&
      this._result !== null &&
      this._simMode !== 'des' &&
      !this._multiuserConnected()
    );
  }

  /** Build or tear down so the world matches the current gate state. */
  private _reevaluate(): void {
    const should = this._shouldRun();
    if (should && !this._active && !this._building) {
      this.buildPromise = this._build();
    } else if (!should && (this._active || this._building)) {
      this._teardown();
    }
  }

  // ═══ World build ══════════════════════════════════════════════════════════

  private async _build(): Promise<void> {
    const gen = this._gen;
    this._building = true;
    try {
      const result = this._result;
      const tm = this._tm;
      if (!result || !tm) return;

      this._ensureZones(result);
      const zones = RVPhysicsZone.zones.filter((z) => z.active);
      if (zones.length === 0) return;

      const acquired = await this._acquireProvider();
      if (gen !== this._gen || !acquired) return;
      const provider = acquired.provider;
      if (acquired.created) physicsRegistry.register(provider);
      this._provider = provider;
      this._providerLive = true;
      this._createdProvider = acquired.created;

      // Zones first: the provider takes the world gravity from the first one.
      for (let i = 0; i < zones.length; i++) {
        const volume = zones[i].worldAabb;
        if (volume) provider.addZone(`zone:${i}`, volume, zones[i].toZoneConfig());
      }
      provider.onSensorEvent = this._onSensorEvent;

      try {
        await provider.init();
      } catch (e) {
        if (gen === this._gen) {
          console.warn('[physics-zone] physics engine not available — staying kinematic:', e);
          this._teardown();
        }
        return;
      }
      if (gen !== this._gen) return; // torn down while the WASM was loading
      if (!provider.ready || provider.failed) {
        console.warn('[physics-zone] physics provider is not ready — staying kinematic');
        this._teardown();
        return;
      }

      result.root.updateMatrixWorld(true);
      this._buildWorld(provider, result, tm, zones);
      this._zoneLimits = zones.map((z) => {
        const v = z.worldAabb as PhysicsAABB;
        return {
          min: { x: v.min.x, y: v.min.y, z: v.min.z },
          max: { x: v.max.x, y: v.max.y, z: v.max.z },
          removeBelowY: z.RemoveBelowY,
        };
      });
      this._minRemoveBelowY = zones.reduce((m, z) => Math.min(m, z.RemoveBelowY), Infinity);

      tm.physicsMUHook = this;
      tm.physicsManagedSurfaces = this._managedSurfaces;
      tm.physicsManagedSensors = this._managedSensorSet;
      this._active = true;
      physicsDiagnostics.active = true;
      physicsDiagnostics.zones = zones.length;
      physicsDiagnostics.bodies = 0;
      physicsDiagnostics.stepMs = 0;
    } catch (e) {
      console.error('[physics-zone] world build failed — physics stays off:', e);
      if (gen === this._gen) this._teardown();
    } finally {
      if (gen === this._gen) this._building = false;
    }
  }

  /** Ensure the synthetic WholeScene zone (F16 convenience default / F17 full physics). */
  private _ensureZones(result: LoadResult): void {
    const zones = RVPhysicsZone.zones;
    const needSynthetic = zones.length === 0 || (physicsSettings.full && !zones.some((z) => z.WholeScene));
    if (!needSynthetic) return;
    const bounds = result.boundingBox;
    if (!bounds || bounds.isEmpty()) return; // no scene extent — nothing to wrap
    const zone = RVPhysicsZone.createSynthetic({ removeBelowY: bounds.min.y - 10 });
    zone.applySceneBounds(bounds);
    this._syntheticZone = zone;
  }

  /** The registered provider, or a lazily created Rapier provider (separate chunk). */
  private async _acquireProvider(): Promise<{ provider: PhysicsProvider; created: boolean } | null> {
    const existing = physicsRegistry.provider;
    if (existing) return { provider: existing, created: false };
    const { RapierPhysicsProvider } = await import('./rv-rapier-provider');
    // Another party may have registered one while the chunk was loading.
    const raced = physicsRegistry.provider;
    if (raced) return { provider: raced, created: false };
    return { provider: new RapierPhysicsProvider(), created: true };
  }

  private _buildWorld(
    provider: PhysicsProvider,
    result: LoadResult,
    tm: RVTransportManager,
    zones: RVPhysicsZone[],
  ): void {
    let staticCount = 0;
    const registered = new Set<Object3D>();

    // Automatic floor plate under the SYNTHETIC zone only (authored zones never get one).
    const synthetic = this._syntheticZone;
    if (synthetic && zones.includes(synthetic) && synthetic.worldAabb) {
      const b = synthetic.worldAabb;
      provider.addStaticBox(
        'floor:synthetic',
        {
          x: (b.min.x + b.max.x) / 2,
          y: b.min.y - PHYSICS_FLOOR_THICKNESS / 2,
          z: (b.min.z + b.max.z) / 2,
        },
        {
          x: (b.max.x - b.min.x) / 2 + PHYSICS_FLOOR_MARGIN,
          y: PHYSICS_FLOOR_THICKNESS / 2,
          z: (b.max.z - b.min.z) / 2 + PHYSICS_FLOOR_MARGIN,
        },
        Q_IDENTITY,
      );
    }

    // Explicit static colliders of the zones (registered regardless of visibility).
    for (const zone of zones) {
      for (const path of zone.StaticColliders) {
        const node = (result.registry?.getNode(path) as Object3D | null | undefined) ?? null;
        if (!node) {
          if (!this._warned.has(`static:${path}`)) {
            this._warned.add(`static:${path}`);
            console.warn(`[physics-zone] StaticColliders entry "${path}" of zone "${zone.node.name}" not found — skipped`);
          }
          continue;
        }
        if (registered.has(node)) continue;
        if (this._addExplicitStatic(provider, node, staticCount)) {
          registered.add(node);
          staticCount++;
        }
      }
    }

    // Implicit static geometry.
    this._addImplicitStaticBoxes(provider, result, tm, zones, registered, staticCount);

    this._buildSurfaces(provider, tm, zones);
    this._buildSensors(provider, tm, zones);
    this._buildSinks(provider, tm, zones);
  }

  /** Fixed box for an explicitly listed node: its BoxCollider extras, else its world bounds. */
  private _addExplicitStatic(provider: PhysicsProvider, node: Object3D, index: number): boolean {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    const raw = rv ? firstValidBox(rv) : null;
    const box: WorldBox = { center: new Vector3(), half: new Vector3(), quat: new Quaternion() };
    if (raw) {
      worldBoxOf(node, raw, box);
    } else {
      node.updateWorldMatrix(true, true);
      const bounds = new Box3().setFromObject(node);
      if (bounds.isEmpty()) return false;
      bounds.getCenter(box.center);
      bounds.getSize(box.half).multiplyScalar(0.5);
    }
    if (box.half.x <= 0 || box.half.y <= 0 || box.half.z <= 0) return false;
    provider.addStaticBox(`staticbox:${index}:${node.name}`, toVec(box.center), toVec(box.half), toQuat(box.quat));
    return true;
  }

  private _addImplicitStaticBoxes(
    provider: PhysicsProvider,
    result: LoadResult,
    tm: RVTransportManager,
    zones: RVPhysicsZone[],
    registered: Set<Object3D>,
    startIndex: number,
  ): void {
    // Nodes that already carry a simulation component are never static geometry.
    const simNodes = new Set<Object3D>();
    const collect = (list: ReadonlyArray<{ node?: Object3D }>): void => {
      for (const c of list) if (c.node) simNodes.add(c.node);
    };
    collect(tm.surfaces);
    collect(tm.sensors);
    collect(tm.sinks);
    collect(tm.sources as unknown as ReadonlyArray<{ node?: Object3D }>);
    collect(tm.grips as unknown as ReadonlyArray<{ node?: Object3D }>);
    collect(tm.gripTargets as unknown as ReadonlyArray<{ node?: Object3D }>);
    for (const z of RVPhysicsZone.zones) simNodes.add(z.node);

    const bounds = result.boundingBox;
    const sceneExt = [
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z,
    ];
    const box: WorldBox = { center: new Vector3(), half: new Vector3(), quat: new Quaternion() };
    const env = new Vector3();
    const envBox: PhysicsAABB = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    let index = startIndex;

    const visit = (node: Object3D): void => {
      if (!node.visible) return; // own or ancestor's `visible = false` prunes the subtree
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rv && rv['activeSelf'] === false) return; // Unity activeInHierarchy: a false ancestor wins
      if (rv && !registered.has(node) && !simNodes.has(node) && !hasSimulationKey(rv)) {
        const raw = firstValidBox(rv);
        if (raw) {
          worldBoxOf(node, raw, box);
          envelopeHalf(box.quat, box.half, env);
          envBox.min.x = box.center.x - env.x; envBox.max.x = box.center.x + env.x;
          envBox.min.y = box.center.y - env.y; envBox.max.y = box.center.y + env.y;
          envBox.min.z = box.center.z - env.z; envBox.max.z = box.center.z + env.z;
          if (zones.some((z) => z.overlapsAABB(envBox))) {
            if (this._spansScene(env, sceneExt)) {
              if (!this._warned.has(node.uuid)) {
                this._warned.add(node.uuid);
                console.warn(
                  `[physics-zone] implicit static box "${node.name}" ` +
                  `(${(box.half.x * 2).toFixed(1)}×${(box.half.y * 2).toFixed(1)}×${(box.half.z * 2).toFixed(1)} m) ` +
                  'spans the scene — skipped (broken collider scale?)',
                );
              }
            } else {
              provider.addStaticBox(
                `staticbox:${index++}:${node.name}`,
                toVec(box.center), toVec(box.half), toQuat(box.quat),
              );
            }
          }
        }
      }
      for (let i = 0; i < node.children.length; i++) visit(node.children[i]);
    };
    visit(result.root);
  }

  /** Oversize guard: ≥ 90 % of the scene extent in at least TWO comparable axes. */
  private _spansScene(envHalf: Vector3, sceneExt: number[]): boolean {
    const boxExt = [envHalf.x * 2, envHalf.y * 2, envHalf.z * 2];
    let exceeding = 0;
    for (let i = 0; i < 3; i++) {
      const s = sceneExt[i];
      if (!Number.isFinite(s) || s <= PHYSICS_SCENE_AXIS_EPSILON) continue; // not comparable
      if (boxExt[i] >= PHYSICS_STATIC_BOX_MAX_SCENE_FRACTION * s) exceeding++;
    }
    return exceeding >= 2;
  }

  private _buildSurfaces(provider: PhysicsProvider, tm: RVTransportManager, zones: RVPhysicsZone[]): void {
    if (!RVTransportSurface.physicsDefault) return; // deployment kill-switch wins over everything
    const full = physicsSettings.full;
    const managed = new Set<RVTransportSurface>();
    const conveyors: ConveyorEntry[] = [];
    let radialInFull = 0;

    for (let i = 0; i < tm.surfaces.length; i++) {
      const surface = tm.surfaces[i];
      if (!full && !surface.PhysicsMode) continue;
      if (surface.Radial) {
        if (full) radialInFull++;
        else console.warn(`[physics-zone] radial surface "${surface.node.name}" (PhysicsMode) is not supported (v1 exclusion) — stays kinematic`);
        continue;
      }
      surface.updateAABB();

      // A surface is physics-managed only when FULLY inside a zone (belts are never cut).
      let zone: RVPhysicsZone | null = null;
      for (const z of zones) {
        if (full ? z.containsAABB(surface.aabb) : surface.isPhysicsManaged(z)) { zone = z; break; }
      }
      if (!zone) {
        if (surface.PhysicsMode && zones.some((z) => z.overlapsAABB(surface.aabb))) {
          console.warn(`[physics-zone] surface "${surface.node.name}" partially overlaps a physics zone — stays kinematic (a belt is never cut by a zone boundary)`);
        }
        continue;
      }

      const id = `conveyor:${i}:${surface.node.name}`;
      provider.addConveyor(id, toVec(surface.aabb.center), toVec(surface.aabb.halfSize), Q_IDENTITY, zone.Friction);
      managed.add(surface);
      conveyors.push({ id, surface });
    }

    if (radialInFull > 0) {
      console.warn(`[physics-zone] full physics (Beta): ${radialInFull} radial surface(s) stay kinematic (v1 exclusion)`);
    }
    this._conveyors = conveyors;
    this._managedSurfaces = managed.size > 0 ? managed : null;
  }

  private _buildSensors(provider: PhysicsProvider, tm: RVTransportManager, zones: RVPhysicsZone[]): void {
    const managedSet = new Set<RVSensor>();
    const list: ManagedSensor[] = [];
    const bounds = new AABB();
    const box: WorldBox = { center: new Vector3(), half: new Vector3(), quat: new Quaternion() };

    for (let i = 0; i < tm.sensors.length; i++) {
      const sensor = tm.sensors[i];
      if (!sensor.PhysicsMode) continue;
      sensor.updateAABB();
      const id = `sensor:${i}:${sensor.node.name}`;

      if (sensor.UseRaycast) {
        sensor.computeRayQueryBounds(bounds);
        if (!zones.some((z) => z.overlapsAABB(bounds))) continue; // beam outside every zone → kinematic
        managedSet.add(sensor);
        list.push({ id, sensor, raycast: true, present: new Set() });
        continue;
      }

      // Collision mode: the authored box (oriented via the world quaternion, LOCAL half
      // extents), else the axis-aligned AABB the kinematic path uses.
      if (!zones.some((z) => z.overlapsAABB(sensor.aabb))) continue;
      const bc = sensor.boxColliderData;
      const raw = bc ? validRawBox(bc) : null;
      if (raw) {
        worldBoxOf(sensor.node, raw, box);
      } else {
        box.center.copy(sensor.aabb.center);
        box.half.copy(sensor.aabb.halfSize);
        box.quat.identity();
      }
      provider.addSensorBox(id, toVec(box.center), toVec(box.half), toQuat(box.quat));
      const entry: ManagedSensor = { id, sensor, raycast: false, present: new Set() };
      managedSet.add(sensor);
      list.push(entry);
      this._sensorById.set(id, entry);
    }

    this._managedSensors = list;
    this._managedSensorSet = managedSet.size > 0 ? managedSet : null;
  }

  /** Sinks inside a zone get a sensor collider (event-based consumption); the kinematic path stays. */
  private _buildSinks(provider: PhysicsProvider, tm: RVTransportManager, zones: RVPhysicsZone[]): void {
    for (let i = 0; i < tm.sinks.length; i++) {
      const sink = tm.sinks[i];
      sink.updateAABB();
      if (!zones.some((z) => z.overlapsAABB(sink.aabb))) continue;
      const id = `sink:${i}:${sink.node.name}`;
      provider.addSensorBox(id, toVec(sink.aabb.center), toVec(sink.aabb.halfSize), Q_IDENTITY);
      this._sinkById.set(id, sink);
    }
  }

  // ═══ Per-tick helpers ═════════════════════════════════════════════════════

  /** Pick up MUs the transport manager handed over (it already called `addDynamicMU`). */
  private _adopt(tm: RVTransportManager): void {
    const mus = tm.mus;
    for (let i = 0; i < mus.length; i++) {
      const mu = mus[i];
      const id = mu.physicsBodyId;
      if (mu.physicsOwned && id !== null && !this._bodies.has(id)) this._bodies.set(id, mu);
    }
  }

  private _feedConveyors(provider: PhysicsProvider): void {
    const list = this._conveyors;
    for (let i = 0; i < list.length; i++) {
      const surface = list[i].surface;
      surface.getWorldDirection(this._dir);
      // Drive speed is mm/s and SIGNED (a reversed belt runs the other way).
      const speed = surface.speed / MM_TO_METERS;
      provider.setConveyorVelocity(list[i].id, this._vel.set(this._dir.x * speed, this._dir.y * speed, this._dir.z * speed));
    }
  }

  private _evaluateSensors(provider: PhysicsProvider): void {
    const list = this._managedSensors;
    for (let i = 0; i < list.length; i++) {
      const ms = list[i];
      let found: AnyMU | null = null;
      if (ms.raycast) {
        const maxDist = ms.sensor.getWorldRay(this._rayOrigin, this._rayDir);
        const hit = provider.castRay(this._rayOrigin, this._rayDir, maxDist);
        if (hit && hit.bodyId !== null) {
          const mu = this._bodies.get(hit.bodyId);
          if (mu && !mu.markedForRemoval) found = mu;
        }
      } else if (ms.present.size > 0) {
        // Prune bodies that vanished WITHOUT a leave event (sink / settle return /
        // removal) — a removed body never drains a stopped event.
        for (const muId of ms.present) {
          const mu = this._bodies.get(muId);
          if (!mu || mu.markedForRemoval) ms.present.delete(muId);
          else if (found === null) found = mu;
        }
      }
      ms.sensor.applyPhysicsResult(found); // same state/onChanged pipeline as the kinematic check
    }
  }

  /** Settled, upright MUs resting over a KINEMATIC surface return to the kinematic pipeline. */
  private _returnSettled(provider: PhysicsProvider, tm: RVTransportManager): void {
    // Exactly once per tick — the provider's settle counters advance per call.
    const settled = provider.getSettledBodies(PHYSICS_SETTLE_LIN_VEL, PHYSICS_UPRIGHT_TOLERANCE_DEG);
    for (let i = 0; i < settled.length; i++) {
      const id = settled[i];
      const mu = this._bodies.get(id);
      if (!mu || mu.markedForRemoval) continue;
      if (!this._restsOnKinematicSurface(mu, tm)) continue; // lying/resting inside the zone stays physics-owned
      provider.removeBody(id);
      this._bodies.delete(id);
      this._dropPresence(id);
      // The synced rest pose is kept 1:1 (no snap) — the kinematic pipeline
      // picks the driving surface on its next tick.
      mu.physicsBodyId = null;
      mu.physicsOwned = false;
    }
  }

  private _restsOnKinematicSurface(mu: AnyMU, tm: RVTransportManager): boolean {
    const managed = this._managedSurfaces;
    const bottom = mu.aabb.min.y;
    for (let i = 0; i < tm.surfaces.length; i++) {
      const s = tm.surfaces[i];
      if (managed !== null && managed.has(s)) continue; // physics surface — the MU is correct there
      if (!s.aabb.overlapsXZ(mu.aabb)) continue;
      if (Math.abs(bottom - s.aabb.max.y) <= RETURN_SURFACE_TOLERANCE) return true;
    }
    return false;
  }

  /** RemoveBelowY of the first zone containing the point, else the minimum over all zones. */
  private _removeBelowFor(x: number, y: number, z: number): number {
    const limits = this._zoneLimits;
    for (let i = 0; i < limits.length; i++) {
      const l = limits[i];
      if (x >= l.min.x && x <= l.max.x && y >= l.min.y && y <= l.max.y && z >= l.min.z && z <= l.max.z) {
        return l.removeBelowY;
      }
    }
    return this._minRemoveBelowY;
  }

  private _dropPresence(muId: string): void {
    const list = this._managedSensors;
    for (let i = 0; i < list.length; i++) list[i].present.delete(muId);
  }

  // ═══ Teardown ═════════════════════════════════════════════════════════════

  /**
   * Drop the physics world: seams unhooked (own instances only), owned MUs
   * released to the kinematic pipeline, provider disposed (`world.free()`).
   * Idempotent; also aborts a pending async build (generation bump).
   */
  private _teardown(): void {
    this._gen++;
    this._building = false;
    this._active = false;

    const tm = this._tm;
    if (tm) {
      if (tm.physicsMUHook === this) tm.physicsMUHook = null;
      if (this._managedSurfaces !== null && tm.physicsManagedSurfaces === this._managedSurfaces) tm.physicsManagedSurfaces = null;
      if (this._managedSensorSet !== null && tm.physicsManagedSensors === this._managedSensorSet) tm.physicsManagedSensors = null;
      // MUs we still own would freeze mid-air: hand them back (no driver → legacy rest).
      for (const mu of tm.mus) {
        if (mu.physicsOwned) {
          mu.physicsOwned = false;
          mu.physicsBodyId = null;
        }
      }
    }
    this._managedSurfaces = null;
    this._managedSensorSet = null;
    this._managedSensors = [];
    this._sensorById.clear();
    this._sinkById.clear();
    this._conveyors = [];
    this._bodies.clear();
    this._zoneLimits = [];

    const provider = this._provider;
    if (provider && this._providerLive) {
      if (provider.onSensorEvent === this._onSensorEvent) provider.onSensorEvent = null; // identity rule
      this._providerLive = false;
      provider.dispose();
    }

    physicsDiagnostics.active = false;
    physicsDiagnostics.zones = 0;
    physicsDiagnostics.bodies = 0;
    physicsDiagnostics.stepMs = 0;
  }
}

function hasSimulationKey(rv: Record<string, unknown>): boolean {
  for (const key of Object.keys(rv)) {
    if (SIMULATION_KEYS.has(key) || key.startsWith('Drive')) return true;
  }
  return false;
}
