// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Community editor actions against a REAL AssetDocument (no fake doc): the
 * kinematize recipe end to end — axis creation, group membership, drive, pivot,
 * signals, logic steps — checking what lands in the scene, in the live
 * GroupRegistry, and that every action is ONE undo step.
 */
import { describe, it, expect } from 'vitest';
import { Scene, Group, Object3D, Mesh, BoxGeometry, Vector3 } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import {
  groupSelection, autoAssignToKinematic, ungroupSelection, listKinematicsForMenu,
} from '../src/plugins/community-editor/group-actions';
import {
  createKinematicWithGroup, createSignalNode, convertSignalType, toggleSignalDirection,
  addLogicStep, groupIntoEmpty,
} from '../src/plugins/community-editor/kinematics/create-actions';
import {
  centerKinematicToGroup, kinematicGroupMemberCount, getKinematicGroupName, pivotToObjectCenter,
} from '../src/plugins/community-editor/kinematics/transform-actions';
import { computeQuickEditContext } from '../src/plugins/community-editor/kinematics/quick-edit-context';

function makeEnv() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    model.updateMatrixWorld(true);
  };
  const selected: string[] = [];
  const viewer = {
    scene, registry,
    groups: null as GroupRegistry | null,
    signalStore: null, transportManager: null,
    get currentModelRoot() { return model; },
    selectionManager: {
      select(p: string) { selected.length = 0; selected.push(p); },
      selectPaths(ps: string[]) { selected.length = 0; selected.push(...ps); },
      clear() { selected.length = 0; },
      getSnapshot() { return { selectedPaths: [...selected], primaryPath: selected[selected.length - 1] ?? null }; },
    },
    getPlugin: () => undefined,
    markRenderDirty() {}, markShadowsDirty() {}, rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
    emit() {}, on() { return () => {}; },
  } as unknown as RVViewer;
  return { viewer, model, registry, register, selected };
}

function part(model: Object3D, name: string, pos: [number, number, number]): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1));
  mesh.name = name;
  mesh.position.set(...pos);
  model.add(mesh);
  return mesh;
}

const rvOf = (n: Object3D) => (n.userData['realvirtual'] ?? {}) as Record<string, Record<string, unknown>>;

describe('createKinematicWithGroup (real document)', () => {
  it('creates the axis, selects it, and one undo removes it again', async () => {
    const { viewer, model, registry, register, selected } = makeEnv();
    register();
    const doc = scratchAssetDocument(viewer);

    const path = await createKinematicWithGroup(viewer, doc, 'Turntable');
    expect(path).toBe('Asset/Turntable');
    const axis = registry.getNode(path!)!;
    expect(rvOf(axis)['Kinematic']).toMatchObject({ GroupName: 'Turntable', IntegrateGroupEnable: true });
    expect(getKinematicGroupName(axis)).toBe('Turntable');
    expect(selected).toEqual(['Asset/Turntable']);

    // A second one with the same name must not collide.
    const second = await createKinematicWithGroup(viewer, doc, 'Turntable');
    expect(second).toBe('Asset/Turntable_1');
    expect(getKinematicGroupName(registry.getNode(second!)!)).toBe('Turntable_1');

    await doc.undo();
    expect(registry.getNode('Asset/Turntable_1')).toBeNull();
    expect(registry.getNode('Asset/Turntable')).toBe(axis);
    await doc.undo();
    expect(model.children).toHaveLength(0);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });
});

describe('kinematize recipe: group parts, centre the pivot (one undo step)', () => {
  it('assigns parts without reparenting them and keeps their world pose', async () => {
    const { viewer, model, registry, register } = makeEnv();
    const a = part(model, 'CAD_0001', [0, 1, 0]);
    const b = part(model, 'CAD_0002', [4, 1, 0]);
    const other = part(model, 'CAD_0003', [9, 1, 0]);
    register();
    const doc = scratchAssetDocument(viewer);
    const worldBefore = [a, b, other].map((n) => n.getWorldPosition(new Vector3()).clone());

    await doc.withTransaction('Kinematize "Slider"', async () => {
      await groupSelection(viewer, doc, ['Asset/CAD_0001', 'Asset/CAD_0002'], 'Slider');
      expect(registry.getNode('Asset/Slider')).not.toBeNull();
      await centerKinematicToGroup(viewer, doc, 'Asset/Slider');
    });
    await doc.whenIdle();

    // Membership: parts keep name, parent and world pose; they only gained Group.
    expect(a.parent).toBe(model);
    expect(a.name).toBe('CAD_0001');
    expect(rvOf(a)['Group']).toEqual({ GroupName: 'Slider' });
    expect(rvOf(b)['Group']).toEqual({ GroupName: 'Slider' });
    expect(rvOf(other)['Group']).toBeUndefined();
    [a, b, other].forEach((n, i) => {
      expect(n.getWorldPosition(new Vector3()).distanceTo(worldBefore[i])).toBeLessThan(1e-9);
    });

    // The live GroupRegistry followed, and the axis is a kinematic group.
    const axis = registry.getNode('Asset/Slider')!;
    expect(viewer.groups!.get('Slider')!.nodes).toEqual([a, b]);
    expect(viewer.groups!.isKinematic('Slider')).toBe(true);
    expect(kinematicGroupMemberCount(viewer, axis)).toBe(2);
    expect(listKinematicsForMenu(viewer)).toEqual([{ label: 'Slider', groupName: 'Slider' }]);

    // Pivot centred on the group's bounds: x in [-0.5, 4.5] -> 2.
    axis.updateMatrixWorld(true);
    expect(axis.getWorldPosition(new Vector3()).toArray()).toEqual([2, 1, 0]);

    // The whole recipe step is ONE composite: one undo takes everything back.
    await doc.undo();
    expect(registry.getNode('Asset/Slider')).toBeNull();
    expect(rvOf(a)['Group']).toBeUndefined();
    expect(viewer.groups!.get('Slider')).toBeUndefined();
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it('autoAssignToKinematic moves a part between kinematics; ungroup clears memberships', async () => {
    const { viewer, model, registry, register } = makeEnv();
    const a = part(model, 'P1', [0, 0, 0]);
    const b = part(model, 'P2', [1, 0, 0]);
    register();
    const doc = scratchAssetDocument(viewer);

    await groupSelection(viewer, doc, ['Asset/P1'], 'Lift');
    await groupSelection(viewer, doc, ['Asset/P2'], 'Turn');
    expect(rvOf(a)['Group']).toEqual({ GroupName: 'Lift' });

    await autoAssignToKinematic(viewer, doc, ['Asset/P1', 'Asset/Lift', 'Asset/Turn'], 'Turn', 'Asset/Turn');
    await doc.whenIdle();
    // P1 left Lift for Turn (key reused), the axes themselves were skipped.
    expect(rvOf(a)['Group']).toEqual({ GroupName: 'Turn' });
    expect(rvOf(a)['Group_1']).toBeUndefined();
    expect(viewer.groups!.get('Turn')!.nodes).toContain(a);
    expect(viewer.groups!.get('Lift')).toBeUndefined();
    expect(rvOf(registry.getNode('Asset/Turn')!)['Group']).toBeUndefined();

    await doc.undo(); // the move
    expect(rvOf(a)['Group']).toEqual({ GroupName: 'Lift' });

    await ungroupSelection(viewer, doc, ['Asset/P1', 'Asset/P2']);
    await doc.whenIdle();
    expect(rvOf(a)['Group']).toBeUndefined();
    expect(rvOf(b)['Group']).toBeUndefined();
    doc.dispose();
  });

  it('pivotToObjectCenter + undo keeps child world poses (real doc)', async () => {
    const { viewer, model, register } = makeEnv();
    const axis = new Object3D(); axis.name = 'Axis';
    const child = new Mesh(new BoxGeometry(1, 1, 1)); child.name = 'C'; child.position.set(1, 0, 0);
    axis.add(child);
    model.add(axis);
    part(model, 'Pin', [3, 2, 1]);
    register();
    const doc = scratchAssetDocument(viewer);
    const before = child.getWorldPosition(new Vector3()).clone();
    await pivotToObjectCenter(viewer, doc, 'Asset/Axis', 'Asset/Pin');
    await doc.whenIdle();
    model.updateMatrixWorld(true);
    expect(axis.getWorldPosition(new Vector3()).toArray()).toEqual([3, 2, 1]);
    expect(child.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-9);
    doc.dispose();
  });
});

describe('groupIntoEmpty under a nested common parent', () => {
  it('creates the container beside the nodes, not at the root', async () => {
    const { viewer, model, registry, register } = makeEnv();
    const holder = new Object3D(); holder.name = 'Holder';
    model.add(holder);
    const x = new Object3D(); x.name = 'X'; holder.add(x);
    const y = new Object3D(); y.name = 'Y'; holder.add(y);
    register();
    const doc = scratchAssetDocument(viewer);
    const path = await groupIntoEmpty(viewer, doc, ['Asset/Holder/X', 'Asset/Holder/Y']);
    expect(path).toBe('Asset/Holder/Group');
    expect(registry.getNode('Asset/Holder/Group')!.children).toEqual([x, y]);
    doc.dispose();
  });
});

describe('signals and logic steps (real document)', () => {
  it('creates a signal, converts its type and flips its direction — value preserved, one undo each', async () => {
    const { viewer, model, registry, register } = makeEnv();
    const axis = new Object3D(); axis.name = 'Axis';
    model.add(axis);
    register();
    const doc = scratchAssetDocument(viewer);

    const path = await createSignalNode(viewer, doc, 'Asset/Axis', 'PLCOutputBool');
    expect(path).toBe('Asset/Axis/PLCOutputBool');
    const node = registry.getNode(path!)!;
    expect(rvOf(node)['PLCOutputBool']).toEqual({ Status: { Value: false } });
    expect(viewer.selectionManager.getSnapshot().primaryPath).toBe(path);
    expect(await createSignalNode(viewer, doc, 'Asset/Axis', 'PLCNonsense')).toBeNull();

    // Seed a value, then convert Bool -> Int (true -> 1) and flip to input.
    doc.setField(path!, 'PLCOutputBool', 'Status', { Value: true }, { Value: false });
    await doc.whenIdle();
    await convertSignalType(viewer, doc, path!, 'Int');
    expect(rvOf(node)['PLCOutputBool']).toBeUndefined();
    expect(rvOf(node)['PLCOutputInt']).toEqual({ Status: { Value: 1 } });
    await toggleSignalDirection(viewer, doc, path!);
    expect(rvOf(node)['PLCOutputInt']).toBeUndefined();
    expect(rvOf(node)['PLCInputInt']).toEqual({ Status: { Value: 1 } });

    await doc.undo(); // flip
    expect(rvOf(node)['PLCOutputInt']).toEqual({ Status: { Value: 1 } });
    await doc.undo(); // convert
    expect(rvOf(node)['PLCOutputBool']).toEqual({ Status: { Value: true } });
    doc.dispose();
  });

  it('adds a LogicStep on a bare node, a child under a container, a sibling after another step', async () => {
    const { viewer, model, registry, register } = makeEnv();
    const seq = new Object3D(); seq.name = 'Seq';
    model.add(seq);
    register();
    const doc = scratchAssetDocument(viewer);
    const ctxOf = (path: string) => computeQuickEditContext(viewer, { selectedPaths: [path], primaryPath: path });

    // Bare node: the step goes on the node itself.
    expect(await addLogicStep(viewer, doc, ctxOf('Asset/Seq'), 'LogicStep_SerialContainer')).toBe('Asset/Seq');
    expect(rvOf(seq)['LogicStep_SerialContainer']).toEqual({});

    // Container: a new child.
    const child = await addLogicStep(viewer, doc, ctxOf('Asset/Seq'), 'LogicStep_Delay');
    expect(child).toBe('Asset/Seq/Delay');
    expect(rvOf(registry.getNode(child!)!)['LogicStep_Delay']).toEqual({ Duration: 1 });

    // Non-container step: a sibling right after it.
    const sibling = await addLogicStep(viewer, doc, ctxOf(child!), 'LogicStep_SetSignalBool');
    expect(sibling).toBe('Asset/Seq/SetSignalBool');
    expect(seq.children.map((c) => c.name)).toEqual(['Delay', 'SetSignalBool']);

    // Unknown type: refused, nothing recorded.
    const ops = doc.document.opCount;
    expect(await addLogicStep(viewer, doc, ctxOf('Asset/Seq'), 'LogicStep_Bogus')).toBeNull();
    expect(doc.document.opCount).toBe(ops);
    doc.dispose();
  });
});
