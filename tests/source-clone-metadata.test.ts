// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVSource clone-metadata regression tests.
 *
 * Bug: a Source placed in the Layout-Planner spawned MUs that duplicated
 * recursively and nested under the source; the source ghost gained
 * `[Source][MU][LayoutObject]` chips and children.
 *
 * Root cause: `Object3D.clone()` deep-copies `userData`, so the source's
 * ghost (`_buildGhost`), held preview, and every spawned-MU clone inherited
 * the source's authored `userData.realvirtual` (including its `Source` entry)
 * and the `_layoutObject` flag. When the placed subtree was later re-processed
 * by `processExtras` those copies became live `RVSource`s — spawning their own
 * clones recursively.
 *
 * Fix: `stripComponentMetadata()` removes `realvirtual` / `_layoutObject` /
 * `_layoutId` from every clone, and `processExtras` skips ghost/preview nodes.
 *
 * A multi-mesh template is used so analyzeTemplate() returns null and spawn()
 * takes the clone() path (the EuropalletLoaded scenario), not the instanced path.
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Scene } from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

/** Build a multi-mesh "loaded pallet" template carrying authored rv-extras
 *  and a layout flag — exactly what a placed source clones from. The two
 *  distinct meshes/materials force the clone() spawn path. */
function createLoadedPalletTemplate(): Object3D {
  const root = new Object3D();
  root.name = 'EuropalletLoaded';
  const pallet = new Mesh(new BoxGeometry(1.2, 0.15, 0.8), new MeshBasicMaterial());
  pallet.name = 'Pallet';
  const carton = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), new MeshStandardMaterial());
  carton.name = 'CartonBox1';
  root.add(pallet, carton);

  // Authored component definition + layout metadata that clone() would copy.
  root.userData.realvirtual = { Source: { Interval: 1 }, MU: {}, LayoutObject: { Label: 'EuropalletLoaded' } };
  root.userData._layoutObject = true;
  root.userData._layoutId = 'lay_orig';
  return root;
}

function createPlacedSource(): { source: RVSource; sceneRoot: Object3D; template: Object3D } {
  const sceneRoot = new Object3D();
  sceneRoot.name = 'SceneRoot';

  const sourceNode = new Object3D();
  sourceNode.name = 'EuropalletLoaded_4';
  sceneRoot.add(sourceNode);

  const template = createLoadedPalletTemplate();
  sceneRoot.add(template);

  const source = new RVSource(sourceNode);
  source.muName = template.name;
  source.sourceIsTemplate = false;
  source.spawnParent = sceneRoot;
  source.spawnMode = 'Interval';
  source.spawnInterval = 0.01;
  source.setTemplate(template);

  return { source, sceneRoot, template };
}

function hasComponentMetadata(obj: Object3D): boolean {
  let found = false;
  obj.traverse((c) => {
    if (c.userData?.realvirtual || c.userData?._layoutObject || c.userData?._layoutId) found = true;
  });
  return found;
}

describe('RVSource — clones must not carry component/layout metadata', () => {
  it('the source ghost carries no Source/LayoutObject rv-extras', () => {
    const { source } = createPlacedSource();
    const ghost = source.node.children.find((c) => c.name === 'EuropalletLoaded_ghost');
    expect(ghost, 'ghost child should exist for a non-self template').toBeTruthy();
    // The ghost itself stays marked as a pure-visual preview …
    expect(ghost!.userData._isSourceGhost).toBe(true);
    // … but must not look like an authored component or layout object.
    expect(hasComponentMetadata(ghost!)).toBe(false);
  });

  it('a spawned MU clone carries no Source/LayoutObject rv-extras', () => {
    const { source, sceneRoot } = createPlacedSource();

    const mu = source.update(1, /* spawningEnabled */ true);
    expect(mu, 'a spawn should occur on the first elapsed interval').toBeTruthy();

    // The clone path names the spawned MU `${template.name}_${count}`.
    const spawned = sceneRoot.children.find((c) => c.name === 'EuropalletLoaded_0');
    expect(spawned, 'spawned clone should be added to the spawn parent (scene root)').toBeTruthy();
    expect(hasComponentMetadata(spawned!)).toBe(false);
  });

  it('a spawned MU clone drops the template\'s hidden raycast BVH proxy', () => {
    // Regression: the force-visible pass in _buildRealClone turned the cloned
    // (engine-internal, hidden) `__raycastBVH_*` proxy visible, so every
    // carrier spawned from that template rendered as a white overlay.
    const { source, sceneRoot, template } = createPlacedSource();
    const proxy = new Mesh(new BoxGeometry(1.2, 0.15, 0.8), new MeshBasicMaterial());
    proxy.name = '__raycastBVH_EuropalletLoaded';
    proxy.visible = false;
    proxy.userData._rvRaycastBVH = true;
    template.add(proxy);

    source.update(1, true);
    const spawned = sceneRoot.children.find((c) => c.name === 'EuropalletLoaded_0');
    expect(spawned).toBeTruthy();
    let proxies = 0;
    spawned!.traverse((c) => { if (c.userData?._rvRaycastBVH) proxies++; });
    expect(proxies).toBe(0);
    // The template keeps its own proxy for picking.
    expect(template.children).toContain(proxy);
  });

  it('spawned MUs are siblings at the spawn parent, never nested under the source', () => {
    const { source, sceneRoot } = createPlacedSource();
    source.update(1, true);
    const spawned = sceneRoot.children.find((c) => c.name === 'EuropalletLoaded_0');
    expect(spawned).toBeTruthy();
    // Walk up the parent chain — the source node must not appear.
    let p: Object3D | null = spawned!.parent;
    let underSource = false;
    while (p) {
      if (p === source.node) underSource = true;
      p = p.parent;
    }
    expect(underSource).toBe(false);
  });
});

describe('RVSource.init — spawn parent must never be the source\'s own subtree', () => {
  /** Minimal ComponentContext for driving init() in isolation. */
  function makeContext(root: Object3D): ComponentContext {
    return {
      registry: { getNode: () => null, registerNode: () => {} } as unknown as ComponentContext['registry'],
      signalStore: {} as unknown as ComponentContext['signalStore'],
      scene: new Scene(),
      transportManager: new RVTransportManager(),
      root,
    };
  }

  it('placed-root source (context.root === node) spawns into the model root, not itself', () => {
    // Mirrors the Layout-Planner placement of EuropalletLoaded: the Source sits
    // on the placed clone's ROOT, and processExtras passes that clone as
    // context.root. Spawning into context.root would nest every MU under the
    // source and recurse for self-templates.
    const modelRoot = new Object3D();
    modelRoot.name = 'ModelRoot';
    const sourceNode = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshBasicMaterial());
    sourceNode.name = 'EuropalletLoaded_4';
    sourceNode.userData.realvirtual = { Source: { Interval: 1 }, MU: {} };
    modelRoot.add(sourceNode);

    const source = new RVSource(sourceNode);
    source.init(makeContext(/* context.root = */ sourceNode));

    expect(source.sourceIsTemplate).toBe(true);
    expect(source.spawnParent).toBe(modelRoot);
    expect(source.spawnParent).not.toBe(sourceNode);
  });

  it('loaded source (context.root is an ancestor) spawns into context.root as before', () => {
    const modelRoot = new Object3D();
    modelRoot.name = 'ModelRoot';
    const sourceNode = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshBasicMaterial());
    sourceNode.name = 'LoadedSource';
    sourceNode.userData.realvirtual = { Source: { Interval: 1 }, MU: {} };
    modelRoot.add(sourceNode);

    const source = new RVSource(sourceNode);
    source.init(makeContext(/* context.root = */ modelRoot));

    expect(source.spawnParent).toBe(modelRoot);
  });
});
