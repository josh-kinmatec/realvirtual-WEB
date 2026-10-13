// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rapier-lib-loader.ts — injectable, lazy loader for the Rapier WASM library.
 *
 * `@dimforge/rapier3d-compat` (Apache-2.0) is deliberately NOT a declared
 * dependency of the public package (rv-physics-registry.ts, "npm note": the
 * Rapier dependency is out-of-band). It must therefore never be imported with a
 * literal specifier — Vite would reject the whole module at transform time
 * when the package is missing. Instead the default loader imports the package
 * file through a VARIABLE URL (`/* @vite-ignore *\/`), which
 *
 *   - works in the Vite dev server / vitest browser mode when the package is
 *     installed (the file is served from `/node_modules/...`),
 *   - rejects at runtime when it is missing → the provider's `init()` rejects →
 *     the plugin treats the provider as "not available" (graceful, kinematic
 *     transport keeps running).
 *
 * The structural `Rapier*` types below cover exactly the slice of the Rapier
 * API the provider uses. They are deliberately local so that
 * `npx tsc --noEmit` passes on machines without the package, and so a test can
 * inject a pure-TS fake world (`setRapierLibLoader`).
 */

// ─── Minimal structural Rapier types (the API subset the provider uses) ─────

export interface RapierVec3 { x: number; y: number; z: number }
export interface RapierQuat { x: number; y: number; z: number; w: number }

export interface RapierRigidBody {
  translation(): RapierVec3;
  rotation(): RapierQuat;
  linvel(): RapierVec3;
  setLinvel(vel: RapierVec3, wakeUp: boolean): void;
  setTranslation(t: RapierVec3, wakeUp: boolean): void;
}

export interface RapierRigidBodyDesc {
  setTranslation(x: number, y: number, z: number): RapierRigidBodyDesc;
  setRotation(q: RapierQuat): RapierRigidBodyDesc;
  setLinvel(x: number, y: number, z: number): RapierRigidBodyDesc;
}

export interface RapierColliderDesc {
  setFriction(f: number): RapierColliderDesc;
  setFrictionCombineRule(rule: number): RapierColliderDesc;
  setRestitution(r: number): RapierColliderDesc;
  setSensor(sensor: boolean): RapierColliderDesc;
  setActiveEvents(events: number): RapierColliderDesc;
}

export interface RapierCollider { readonly handle: number }

export interface RapierEventQueue {
  /** Applies `cb` to every collision event, then clears the buffer. */
  drainCollisionEvents(cb: (handle1: number, handle2: number, started: boolean) => void): void;
  /** WASM memory is NOT garbage collected — mandatory at teardown. */
  free(): void;
}

/** Result of a ray cast. Rapier ≤ 0.12 names the distance `toi`, later
 *  versions `timeOfImpact` — the provider reads whichever is present. */
export interface RapierRayHit {
  collider: RapierCollider;
  timeOfImpact?: number;
  toi?: number;
}

export interface RapierRay {
  origin: RapierVec3;
  dir: RapierVec3;
}

export interface RapierWorld {
  /** Fixed timestep in seconds — `step()` itself takes NO dt. */
  timestep: number;
  step(eventQueue?: RapierEventQueue): void;
  createRigidBody(desc: RapierRigidBodyDesc): RapierRigidBody;
  createCollider(desc: RapierColliderDesc, parent?: RapierRigidBody): RapierCollider;
  removeRigidBody(body: RapierRigidBody): void;
  castRay(ray: RapierRay, maxToi: number, solid: boolean, filterFlags?: number): RapierRayHit | null;
  /** WASM heap is not JS-GC managed — `free()` is mandatory. */
  free(): void;
}

export interface RapierLib {
  init(): Promise<void>;
  World: new (gravity: RapierVec3) => RapierWorld;
  EventQueue: new (autoDrain: boolean) => RapierEventQueue;
  Ray: new (origin: RapierVec3, dir: RapierVec3) => RapierRay;
  RigidBodyDesc: {
    dynamic(): RapierRigidBodyDesc;
    fixed(): RapierRigidBodyDesc;
    kinematicVelocityBased(): RapierRigidBodyDesc;
  };
  ColliderDesc: {
    cuboid(hx: number, hy: number, hz: number): RapierColliderDesc;
  };
  CoefficientCombineRule: { Max: number };
  ActiveEvents: { COLLISION_EVENTS: number };
  QueryFilterFlags: { EXCLUDE_SENSORS: number };
}

// ─── Loader seam ────────────────────────────────────────────────────────────

/** Produces the (not yet `init()`-ed) Rapier module. Injectable for tests. */
export type RapierLibLoader = () => Promise<RapierLib>;

/**
 * Candidate URLs of the out-of-band package file, tried in order. Rapier
 * >= 0.13 ships `rapier.mjs`; the 0.12 compat package ships `rapier.es.js`
 * (both are plain ESM with the WASM inlined as base64).
 */
const DEFAULT_MODULE_URLS: readonly string[] = [
  '/node_modules/@dimforge/rapier3d-compat/rapier.mjs',
  '/node_modules/@dimforge/rapier3d-compat/rapier.es.js',
];

let moduleUrlOverride: string | null = null;
let customLoader: RapierLibLoader | null = null;
let libPromise: Promise<RapierLib> | null = null;

/**
 * Point the default loader at a deployed copy of the Rapier ES module (a
 * production build does not serve `/node_modules/`). `null` restores the
 * default candidates. Clears the cached library.
 */
export function setRapierModuleUrl(url: string | null): void {
  moduleUrlOverride = url;
  libPromise = null;
}

/**
 * Replace the loader (tests inject a fake world here). `null` restores the
 * default URL loader. Always clears the cached library so the next
 * `loadRapierLib()` runs the (new) loader.
 */
export function setRapierLibLoader(loader: RapierLibLoader | null): void {
  customLoader = loader;
  libPromise = null;
}

/** Default loader: variable-URL dynamic import — see the file header. */
async function defaultLoader(): Promise<RapierLib> {
  const urls = moduleUrlOverride ? [moduleUrlOverride] : DEFAULT_MODULE_URLS;
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const mod = (await import(/* @vite-ignore */ url)) as RapierLib & { default?: RapierLib };
      // The compat package exposes everything as named exports AND as a default object.
      const lib = typeof mod.World === 'function' ? mod : mod.default;
      if (lib && typeof lib.World === 'function') return lib;
      lastError = new Error(`[rapier] module at ${url} does not export World`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('[rapier] @dimforge/rapier3d-compat is not available');
}

/**
 * Load AND initialise the Rapier library exactly once (the promise is cached;
 * a rejection clears the cache so a later call can retry).
 */
export function loadRapierLib(): Promise<RapierLib> {
  if (libPromise) return libPromise;
  const loader = customLoader ?? defaultLoader;
  const p = (async () => {
    const lib = await loader();
    await lib.init();
    return lib;
  })();
  libPromise = p;
  p.catch(() => {
    if (libPromise === p) libPromise = null;
  });
  return p;
}
