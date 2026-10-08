import { describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { SceneManager } from './SceneManager';
import { gearbox, ASSEMBLIES } from '../../data';

// Only the download is faked; everything after it is the real loader code.
const loadContainer = vi.hoisted(() => vi.fn());
vi.mock('@babylonjs/core/Loading/sceneLoader', async (actual) => ({
  ...(await actual<object>()),
  LoadAssetContainerAsync: loadContainer,
}));

const make = () => new SceneManager(document.createElement('canvas'), gearbox, {}, {
  engine: new NullEngine(), kind: 'webgl',
  perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
});

describe('switching assemblies', () => {
  it('leaves no materials or meshes behind from the one before', () => {
    const manager = make();
    const scene = (manager as unknown as { scene: { materials: unknown[]; meshes: unknown[] } }).scene;
    const other = ASSEMBLIES.find((a) => a.id !== gearbox.id && a.parts.every((p) => p.mesh.type !== 'url'))!;
    const materials = scene.materials.length;
    const meshes = scene.meshes.length;
    for (let i = 0; i < 3; i++) {
      manager.loadAssembly(other);
      manager.loadAssembly(gearbox);
    }
    expect(scene.materials.length, 'materials after three round trips').toBe(materials);
    expect(scene.meshes.length, 'meshes after three round trips').toBe(meshes);
    manager.dispose();
  });
});

describe('a model that finishes downloading after its part is gone', () => {
  it('is dropped, not added to the scene under a disposed node', async () => {
    const container = { meshes: [] as unknown[], addAllToScene: vi.fn(), dispose: vi.fn() };
    loadContainer.mockResolvedValueOnce(container);
    const { loadPartModel } = await import('./gltf');
    const engine = new NullEngine();
    const { Scene } = await import('@babylonjs/core/scene');
    const scene = new Scene(engine);
    const parent = new TransformNode('gone', scene);
    parent.dispose();
    expect(await loadPartModel(scene, 'part.glb', parent)).toBeUndefined();
    expect(container.addAllToScene).not.toHaveBeenCalled();
    expect(container.dispose).toHaveBeenCalledOnce();

    // …while a part that is still there gets its model.
    const live = new TransformNode('here', scene);
    loadContainer.mockResolvedValueOnce(container);
    expect(await loadPartModel(scene, 'part.glb', live)).toBeDefined();
    expect(container.addAllToScene).toHaveBeenCalledOnce();
    engine.dispose();
  });
});

describe('one scene update', () => {
  it('measures the assembly once, not once per part', () => {
    const manager = make();
    const internals = manager as unknown as { updateGroundContact: () => void; outlineScale: () => number };
    const contact = vi.spyOn(internals, 'updateGroundContact');
    const scale = vi.spyOn(internals, 'outlineScale');
    manager.update({
      placements: new Map(), severityByPart: new Map(), selectedPartId: gearbox.parts[0].id,
      activePartIds: new Set(gearbox.parts.map((p) => p.id)), explodeFactor: 0, showBackground: true,
      showGhosts: true, recognitionByPart: new Map(),
    } as never);
    expect(gearbox.parts.length).toBeGreaterThan(3);
    expect(contact).toHaveBeenCalledOnce();
    expect(scale).toHaveBeenCalledOnce();
    manager.dispose();
  });
});

describe('the per-frame tick', () => {
  const base = {
    placements: new Map(), severityByPart: new Map(), selectedPartId: undefined,
    activePartIds: new Set<string>(), explodeFactor: 0, showBackground: true, showGhosts: true,
    recognitionByPart: new Map(),
  };

  it('leaves a paused animation alone — its position only changes through the store', () => {
    const manager = make();
    manager.update({ ...base, timeline: { durationS: 4, tracks: [], markers: [] }, timelineT: 1 } as never);
    const update = vi.spyOn(manager, 'update');
    for (let i = 0; i < 10; i++) manager.tick();
    expect(update).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('but keeps a part in error pulsing', () => {
    const manager = make();
    manager.update({ ...base, severityByPart: new Map([[gearbox.parts[0].id, 'error']]) } as never);
    const update = vi.spyOn(manager, 'update');
    for (let i = 0; i < 3; i++) manager.tick();
    expect(update).toHaveBeenCalledTimes(3);
    manager.dispose();
  });
});
