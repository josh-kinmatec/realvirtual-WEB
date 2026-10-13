// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * community-physics — a community implementation of the optional zone-based
 * rigid-body physics (MUs falling, sliding, tipping and stacking inside a
 * physics zone; kinematic → dynamic handover and settle return).
 *
 * The public core owns the contract (`PhysicsProvider`, `physicsRegistry`,
 * `IPhysicsMUHook`), the zone component and the handover hooks in the transport
 * manager. This folder adds the two missing pieces:
 *
 *  - `RapierPhysicsProvider` — the engine, on top of Rapier (Rust → WASM).
 *  - `PhysicsZonePlugin`     — the lifecycle owner (world build per model load,
 *    step + pose sync per tick, settle return, DES / multiuser / reset guards).
 *
 * ## Opt-in, nothing heavy by default
 *
 * `registerCommunityPhysics` only registers the (small) plugin. Until the
 * load-time gate `physicsSettings.enabled` is on (settings.json kill-switch AND
 * the user's `localStorage['rv.physics']` toggle, evaluated once at boot in
 * main.ts) the plugin does nothing at all: no provider is created, no Rapier
 * code is requested. With the gate on, the provider is created lazily (its own
 * chunk) and Rapier is loaded on first `init()`.
 *
 * ## Rapier is out-of-band
 *
 * `@dimforge/rapier3d-compat` (Apache-2.0) is deliberately not a declared
 * dependency. The default loader imports its ES module through a URL
 * (`/node_modules/@dimforge/rapier3d-compat/…` — works in the dev server);
 * a production deployment serves a copy of that file and points the loader at it
 * with `setRapierModuleUrl(url)` (see `rapier-lib-loader.ts`). When the file is
 * missing the provider's `init()` rejects, the plugin logs one warning and the
 * simulation simply stays kinematic.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { PHYSICS_ZONE_PLUGIN_ID, PhysicsZonePlugin } from './physics-zone-plugin';

// The provider and the loader are deliberately NOT re-exported here: the plugin
// imports the provider dynamically so it stays out of the main chunk. Import
// them from their own modules when needed (`setRapierModuleUrl` lives in
// `./rapier-lib-loader`).
export { PhysicsZonePlugin, PHYSICS_ZONE_PLUGIN_ID } from './physics-zone-plugin';

/**
 * Register the physics-zone plugin with the viewer. Idempotent (a second call
 * on the same viewer is a no-op). Call it from the feature-registration hook
 * (`registerPrivatePlugins`).
 */
export function registerCommunityPhysics(viewer: RVViewer): void {
  if (viewer.getPlugin(PHYSICS_ZONE_PLUGIN_ID)) return;
  viewer.use(new PhysicsZonePlugin(), 'core');
}
