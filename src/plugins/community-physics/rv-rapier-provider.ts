// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-rapier-provider.ts — `PhysicsProvider` implementation on top of Rapier
 * (Rust → WASM, Apache-2.0), community edition.
 *
 * Implements the contract documented in `core/engine/rv-physics-registry.ts`:
 *
 *  - `init()` is lazy and re-entrancy-safe (one promise is reused); the WASM is
 *    loaded through the injectable loader (`rapier-lib-loader.ts`).
 *  - `dispose()` frees world + event queue (WASM memory is not garbage
 *    collected) and is safe while an `init()` is still pending (the pending
 *    init notices the generation change and aborts without creating a world).
 *  - `step(dt)` advances the world one FIXED step. After the first exception
 *    the provider fails off permanently (`failed`, ONE error log, every
 *    further call is a no-op).
 *  - `removeBody()` is two-phase and idempotent: bodies are marked and freed
 *    at the END of the next `step()`, never mid-tick.
 *
 * Modelling choices (the repo defines no more than the contract, these are the
 * simplest sensible ones):
 *
 *  - ONE world, gravity from the FIRST registered zone (default 0,-9.81,0).
 *  - MUs, static boxes and conveyors take friction/restitution from the first
 *    registered zone whose AABB contains their position (defaults 0.8 / 0);
 *    friction is combined with the `Max` rule, so a high-friction belt carries
 *    a low-friction MU (and a slippery zone stays slippery).
 *  - Conveyors are kinematic VELOCITY-based bodies. Rapier translates such a
 *    body with its velocity, so a moving belt would wander off its authored
 *    position — it is snapped back onto its origin before every step while the
 *    velocity keeps producing the friction take-along.
 *  - Sensors are sensor colliders on fixed bodies with collision events; the
 *    enter/leave pair is reported through `onSensorEvent` during `step()`.
 *
 * This file must not import Three.js; Rapier is only reached through the
 * structural types of `rapier-lib-loader.ts`.
 */

import type {
  PhysicsAABB,
  PhysicsPose,
  PhysicsProvider,
  PhysicsQuat,
  PhysicsRayHit,
  PhysicsVec3,
  PhysicsZoneConfig,
} from '../../core/engine/rv-physics-registry';
import {
  PHYSICS_FIXED_DT,
  PHYSICS_SETTLE_FRAMES,
} from '../../core/engine/rv-physics-constants';
import {
  loadRapierLib,
  type RapierEventQueue,
  type RapierLib,
  type RapierRay,
  type RapierRigidBody,
  type RapierWorld,
} from './rapier-lib-loader';

/** World gravity when no zone provides one (m/s²). */
const DEFAULT_GRAVITY: PhysicsVec3 = { x: 0, y: -9.81, z: 0 };
/** Friction / restitution outside every registered zone. */
const DEFAULT_FRICTION = 0.8;
const DEFAULT_RESTITUTION = 0;
/** Smallest half extent handed to Rapier (a zero-size cuboid is degenerate). */
const MIN_HALF_EXTENT = 0.001;

/** What a collider handle belongs to (event + ray-cast id mapping). */
const enum HandleKind { Mu = 0, Sensor = 1, Other = 2 }

interface HandleInfo { kind: HandleKind; id: string }

interface MuBody {
  body: RapierRigidBody;
  handle: number;
  /** Consecutive ticks below the settle velocity threshold. */
  calmTicks: number;
}

interface ConveyorBody {
  body: RapierRigidBody;
  origin: PhysicsVec3;
  vel: PhysicsVec3;
  /** Velocity last written into the body (change detection). */
  appliedVel: PhysicsVec3;
  /** True while the body may be displaced from its origin. */
  displaced: boolean;
}

interface ZoneEntry { id: string; aabb: PhysicsAABB; cfg: PhysicsZoneConfig }

export class RapierPhysicsProvider implements PhysicsProvider {
  // ── PhysicsProvider state ─────────────────────────────────────────────────
  private _ready = false;
  private _failed = false;
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;

  get ready(): boolean { return this._ready; }
  get failed(): boolean { return this._failed; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  private _initPromise: Promise<void> | null = null;
  /** Bumped by `dispose()`: lets a pending `init()` detect that it was cancelled. */
  private _generation = 0;

  private _lib: RapierLib | null = null;
  private _world: RapierWorld | null = null;
  private _eventQueue: RapierEventQueue | null = null;
  private _ray: RapierRay | null = null;

  // ── World content ─────────────────────────────────────────────────────────
  private readonly _zones: ZoneEntry[] = [];
  private readonly _muBodies = new Map<string, MuBody>();
  private readonly _conveyors = new Map<string, ConveyorBody>();
  /** collider handle → owner (sensor events, ray hits). */
  private readonly _handles = new Map<number, HandleInfo>();
  /** MU ids marked by `removeBody()` and freed at the end of the next step. */
  private readonly _pendingRemoval = new Set<string>();
  /** Dynamic MU bodies that are NOT marked for removal. */
  private _liveCount = 0;

  // ── Reused scratch (zero-GC per tick) ─────────────────────────────────────
  private readonly _outPos: PhysicsVec3 = { x: 0, y: 0, z: 0 };
  private readonly _outQuat: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly _settled: string[] = [];
  private readonly _drainEvent = (h1: number, h2: number, started: boolean): void => {
    this._handleCollisionEvent(h1, h2, started);
  };

  // ═══ init / dispose ═══════════════════════════════════════════════════════

  init(): Promise<void> {
    if (this._initPromise) return this._initPromise;
    const generation = this._generation;
    const p = this._doInit(generation);
    this._initPromise = p;
    p.catch(() => {
      // A failed load must not poison later retries.
      if (this._initPromise === p) this._initPromise = null;
    });
    return p;
  }

  private async _doInit(generation: number): Promise<void> {
    if (this._failed) return; // permanently off — stays not ready
    const lib = await loadRapierLib();
    // dispose() ran while the loader was pending → abort without a world.
    if (generation !== this._generation) return;

    const gravity = this._zones.length > 0 ? this._zones[0].cfg.gravity ?? DEFAULT_GRAVITY : DEFAULT_GRAVITY;
    const world = new lib.World({ x: gravity.x, y: gravity.y, z: gravity.z });
    world.timestep = PHYSICS_FIXED_DT;
    this._lib = lib;
    this._world = world;
    this._eventQueue = new lib.EventQueue(true);
    this._ray = new lib.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this._ready = true;
  }

  dispose(): void {
    this._generation++;
    this._initPromise = null;
    this._ready = false;
    // Freeing order: bodies/colliders live inside the world; the queue is separate.
    if (this._eventQueue) {
      try { this._eventQueue.free(); } catch { /* already freed */ }
    }
    if (this._world) {
      try { this._world.free(); } catch { /* already freed */ }
    }
    this._eventQueue = null;
    this._world = null;
    this._lib = null;
    this._ray = null;
    this._zones.length = 0;
    this._muBodies.clear();
    this._conveyors.clear();
    this._handles.clear();
    this._pendingRemoval.clear();
    this._liveCount = 0;
  }

  // ═══ World building ═══════════════════════════════════════════════════════

  addZone(id: string, aabb: PhysicsAABB, cfg: PhysicsZoneConfig): void {
    if (this._failed) return;
    this._zones.push({
      id,
      aabb: {
        min: { x: aabb.min.x, y: aabb.min.y, z: aabb.min.z },
        max: { x: aabb.max.x, y: aabb.max.y, z: aabb.max.z },
      },
      cfg: { ...cfg },
    });
  }

  addStaticBox(id: string, center: PhysicsVec3, halfExtents: PhysicsVec3, quat: PhysicsQuat): void {
    const env = this._env();
    if (!env) return;
    const { lib, world } = env;
    const zone = this._zoneAt(center.x, center.y, center.z);
    const body = world.createRigidBody(
      lib.RigidBodyDesc.fixed()
        .setTranslation(center.x, center.y, center.z)
        .setRotation(quat),
    );
    const collider = world.createCollider(
      lib.ColliderDesc.cuboid(
        Math.max(halfExtents.x, MIN_HALF_EXTENT),
        Math.max(halfExtents.y, MIN_HALF_EXTENT),
        Math.max(halfExtents.z, MIN_HALF_EXTENT),
      )
        .setFriction(zone ? zone.friction : DEFAULT_FRICTION)
        .setFrictionCombineRule(lib.CoefficientCombineRule.Max)
        .setRestitution(zone ? zone.restitution : DEFAULT_RESTITUTION),
      body,
    );
    this._handles.set(collider.handle, { kind: HandleKind.Other, id });
  }

  addConveyor(
    id: string,
    center: PhysicsVec3,
    halfExtents: PhysicsVec3,
    quat: PhysicsQuat,
    friction: number,
  ): void {
    const env = this._env();
    if (!env) return;
    const { lib, world } = env;
    const body = world.createRigidBody(
      lib.RigidBodyDesc.kinematicVelocityBased()
        .setTranslation(center.x, center.y, center.z)
        .setRotation(quat),
    );
    const collider = world.createCollider(
      lib.ColliderDesc.cuboid(
        Math.max(halfExtents.x, MIN_HALF_EXTENT),
        Math.max(halfExtents.y, MIN_HALF_EXTENT),
        Math.max(halfExtents.z, MIN_HALF_EXTENT),
      )
        .setFriction(friction)
        .setFrictionCombineRule(lib.CoefficientCombineRule.Max)
        .setRestitution(0),
      body,
    );
    this._handles.set(collider.handle, { kind: HandleKind.Other, id });
    this._conveyors.set(id, {
      body,
      origin: { x: center.x, y: center.y, z: center.z },
      vel: { x: 0, y: 0, z: 0 },
      appliedVel: { x: 0, y: 0, z: 0 },
      displaced: false,
    });
  }

  setConveyorVelocity(id: string, vel: PhysicsVec3): void {
    if (this._failed) return;
    const c = this._conveyors.get(id);
    if (!c) return;
    c.vel.x = vel.x;
    c.vel.y = vel.y;
    c.vel.z = vel.z;
  }

  /** Test/diagnostic accessor: the belt body's CURRENT translation (copy). */
  getConveyorTranslation(id: string): PhysicsVec3 | null {
    const c = this._conveyors.get(id);
    if (!c) return null;
    const t = c.body.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  addSensorBox(id: string, center: PhysicsVec3, halfExtents: PhysicsVec3, quat: PhysicsQuat): void {
    const env = this._env();
    if (!env) return;
    const { lib, world } = env;
    const body = world.createRigidBody(
      lib.RigidBodyDesc.fixed()
        .setTranslation(center.x, center.y, center.z)
        .setRotation(quat),
    );
    const collider = world.createCollider(
      lib.ColliderDesc.cuboid(
        Math.max(halfExtents.x, MIN_HALF_EXTENT),
        Math.max(halfExtents.y, MIN_HALF_EXTENT),
        Math.max(halfExtents.z, MIN_HALF_EXTENT),
      )
        .setSensor(true)
        .setActiveEvents(lib.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    this._handles.set(collider.handle, { kind: HandleKind.Sensor, id });
  }

  addDynamicMU(muId: string, pose: PhysicsPose, halfExtents: PhysicsVec3, initialVel: PhysicsVec3): void {
    const env = this._env();
    if (!env) return;
    const { lib, world } = env;

    // Re-handover of an id that is still waiting for its removal flush: free the
    // old body NOW (no step is running — this is not "mid-tick").
    if (this._pendingRemoval.delete(muId)) this._freeBody(muId);
    if (this._muBodies.has(muId)) return; // already a dynamic body — never double-add

    const zone = this._zoneAt(pose.pos.x, pose.pos.y, pose.pos.z);
    const body = world.createRigidBody(
      lib.RigidBodyDesc.dynamic()
        .setTranslation(pose.pos.x, pose.pos.y, pose.pos.z)
        .setRotation(pose.quat)
        .setLinvel(initialVel.x, initialVel.y, initialVel.z),
    );
    const collider = world.createCollider(
      lib.ColliderDesc.cuboid(
        Math.max(halfExtents.x, MIN_HALF_EXTENT),
        Math.max(halfExtents.y, MIN_HALF_EXTENT),
        Math.max(halfExtents.z, MIN_HALF_EXTENT),
      )
        .setFriction(zone ? zone.friction : DEFAULT_FRICTION)
        .setFrictionCombineRule(lib.CoefficientCombineRule.Max)
        .setRestitution(zone ? zone.restitution : DEFAULT_RESTITUTION),
      body,
    );
    this._muBodies.set(muId, { body, handle: collider.handle, calmTicks: 0 });
    this._handles.set(collider.handle, { kind: HandleKind.Mu, id: muId });
    this._liveCount++;
  }

  removeBody(muId: string): void {
    if (this._failed) return;
    if (!this._muBodies.has(muId) || this._pendingRemoval.has(muId)) return; // unknown / double mark
    this._pendingRemoval.add(muId);
    this._liveCount--;
  }

  // ═══ Queries ══════════════════════════════════════════════════════════════

  castRay(origin: PhysicsVec3, dir: PhysicsVec3, maxDist: number): PhysicsRayHit | null {
    const env = this._env();
    const ray = this._ray;
    if (!env || !ray) return null;
    ray.origin.x = origin.x; ray.origin.y = origin.y; ray.origin.z = origin.z;
    ray.dir.x = dir.x; ray.dir.y = dir.y; ray.dir.z = dir.z;
    const hit = env.world.castRay(ray, maxDist, true, env.lib.QueryFilterFlags.EXCLUDE_SENSORS);
    if (!hit) return null;
    const info = this._handles.get(hit.collider.handle);
    return {
      distance: hit.timeOfImpact ?? hit.toi ?? 0,
      bodyId: info ? info.id : null,
    };
  }

  // ═══ Per tick ═════════════════════════════════════════════════════════════

  step(_dt: number): void {
    if (!this._ready || this._failed) return;
    const world = this._world;
    const queue = this._eventQueue;
    if (!world || !queue) return;
    // `_dt` is the fixed accumulator step. Rapier takes its dt from
    // `world.timestep` (set once at init) — it is never driven by a frame delta.
    try {
      this._driveConveyors();
      // No dynamic bodies → nothing can move or collide: skip the solver.
      if (this._liveCount > 0) {
        world.step(queue);
        queue.drainCollisionEvents(this._drainEvent);
      }
      this._flushRemovals();
    } catch (e) {
      this._failed = true; // `ready` stays true until dispose(): the world still has to be freed
      console.error('[RapierPhysicsProvider] step failed — physics is permanently disabled for this session:', e);
    }
  }

  syncPoses(out: (muId: string, pos: PhysicsVec3, quat: PhysicsQuat) => void): void {
    if (!this._ready || this._failed) return;
    const pos = this._outPos;
    const quat = this._outQuat;
    for (const [muId, mb] of this._muBodies) {
      if (this._pendingRemoval.has(muId)) continue; // logically gone
      const t = mb.body.translation();
      const r = mb.body.rotation();
      pos.x = t.x; pos.y = t.y; pos.z = t.z;
      quat.x = r.x; quat.y = r.y; quat.z = r.z; quat.w = r.w;
      out(muId, pos, quat);
    }
  }

  getSettledBodies(maxLinVel: number, uprightToleranceDeg: number): string[] {
    const settled = this._settled;
    settled.length = 0;
    if (!this._ready || this._failed) return settled;
    const maxSq = maxLinVel * maxLinVel;
    // cos of the tolerance: upright when (up · worldUp) >= cos(tol).
    const minUp = Math.cos((uprightToleranceDeg * Math.PI) / 180);
    for (const [muId, mb] of this._muBodies) {
      if (this._pendingRemoval.has(muId)) continue;
      const v = mb.body.linvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z < maxSq) mb.calmTicks++;
      else mb.calmTicks = 0;
      if (mb.calmTicks < PHYSICS_SETTLE_FRAMES) continue;
      // Body-local +Y rotated into world, Y component: 1 − 2(qx² + qz²).
      const q = mb.body.rotation();
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      if (upY >= minUp) settled.push(muId);
    }
    return settled;
  }

  // ═══ Internals ════════════════════════════════════════════════════════════

  /** The live world + lib, or null when not ready / failed (every builder no-ops). */
  private _env(): { lib: RapierLib; world: RapierWorld } | null {
    if (!this._ready || this._failed || !this._lib || !this._world) return null;
    return { lib: this._lib, world: this._world };
  }

  /** Config of the first registered zone containing the point (F2: first wins). */
  private _zoneAt(x: number, y: number, z: number): PhysicsZoneConfig | null {
    for (let i = 0; i < this._zones.length; i++) {
      const a = this._zones[i].aabb;
      if (x >= a.min.x && x <= a.max.x && y >= a.min.y && y <= a.max.y && z >= a.min.z && z <= a.max.z) {
        return this._zones[i].cfg;
      }
    }
    return null;
  }

  /**
   * Keep every moving belt on its authored origin: Rapier integrates a
   * velocity-based kinematic body, so it is snapped back before each step while
   * the velocity (the friction take-along) is re-applied.
   */
  private _driveConveyors(): void {
    for (const c of this._conveyors.values()) {
      const v = c.vel;
      const a = c.appliedVel;
      const moving = v.x !== 0 || v.y !== 0 || v.z !== 0;
      const changed = v.x !== a.x || v.y !== a.y || v.z !== a.z;
      if (!moving && !changed && !c.displaced) continue; // idle belt — leave the world alone
      c.body.setTranslation(c.origin, moving);
      if (changed) c.body.setLinvel(v, true);
      a.x = v.x; a.y = v.y; a.z = v.z;
      c.displaced = moving; // the coming step translates a moving belt again
    }
  }

  private _flushRemovals(): void {
    if (this._pendingRemoval.size === 0) return;
    for (const muId of this._pendingRemoval) this._freeBody(muId);
    this._pendingRemoval.clear();
  }

  /** Remove one MU body from the world + bookkeeping (idempotent). The caller
   *  owns `_pendingRemoval` / `_liveCount` (a marked body is already off the count). */
  private _freeBody(muId: string): void {
    const mb = this._muBodies.get(muId);
    if (!mb) return;
    this._world?.removeRigidBody(mb.body); // also removes the attached collider
    this._handles.delete(mb.handle);
    this._muBodies.delete(muId);
  }

  /** Map a Rapier collision event to a sensor enter/leave callback. */
  private _handleCollisionEvent(h1: number, h2: number, started: boolean): void {
    const cb = this.onSensorEvent;
    if (!cb) return;
    const a = this._handles.get(h1);
    const b = this._handles.get(h2);
    if (!a || !b) return;
    // Either order: (sensor, MU) or (MU, sensor); anything else is not ours.
    if (a.kind === HandleKind.Sensor && b.kind === HandleKind.Mu) cb(a.id, b.id, started);
    else if (b.kind === HandleKind.Sensor && a.kind === HandleKind.Mu) cb(b.id, a.id, started);
  }
}
