// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * private-plugins.ts — feature-registration hook for builds without the private folder.
 *
 * When the private folder (realvirtual-WebViewer-Private~) is absent, Vite resolves
 * `@rv-private/private-plugins` to this file. The private build registers its licensed
 * subsystems here; a community build registers the community implementations that
 * live in `src/plugins/community-editor/`:
 *
 *  - the asset-editor workspace (mode + plugin), driven through the MCP tools,
 *  - the Rapier physics zone plugin (opt-in at runtime through the 'rv.physics' setting).
 */

import type { RVViewer } from '../core/rv-viewer';
import { registerCommunityEditor } from '../plugins/community-editor';
import { registerCommunityPhysics } from '../plugins/community-physics';

export async function registerPrivatePlugins(viewer: RVViewer): Promise<void> {
  registerCommunityEditor(viewer);
  registerCommunityPhysics(viewer);
}
