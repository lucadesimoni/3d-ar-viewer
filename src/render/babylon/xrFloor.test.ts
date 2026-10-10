import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';
import type { Pose } from '../../engine/types';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./xr', () => ({ prepareImmersiveAr: prepare }));

afterEach(() => vi.restoreAllMocks());

const flat = (y: number): Pose => ({ position: [0, y, -1], rotation: [0, 0, 0, 1] });

async function inSession() {
  const hooks: XrHooks[] = [];
  prepare.mockImplementation(async (_scene: unknown, _overlay: unknown, callbacks: XrHooks) => {
    hooks.push(callbacks);
    return { enter: async () => ({ end: vi.fn(async () => {}) }), dispose: vi.fn() };
  });
  const manager = new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });
  await manager.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
  await manager.startWebXr(vi.fn(), vi.fn());
  const hook = hooks[hooks.length - 1];
  hook.onStateChange?.(true);
  const cameraY = manager.scene.activeCamera!.globalPosition.y;
  return { manager, hook, cameraY };
}

describe('the floor a WebXR session has shown', () => {
  it('is learned from the surface hits, well below the phone', async () => {
    const { manager, hook, cameraY } = await inSession();
    expect(manager.xrFloorY()).toBeUndefined();
    for (let i = 0; i < 12; i++) hook.onReticle?.(flat(cameraY - 1.2));
    expect(manager.xrFloorY()).toBeCloseTo(cameraY - 1.2, 2);
  });

  it('is not the top of something the phone is just above', async () => {
    const { manager, hook, cameraY } = await inSession();
    for (let i = 0; i < 40; i++) hook.onReticle?.(flat(cameraY - 0.6));
    expect(manager.xrFloorY()).toBeUndefined();
  });

  it('starts over with each session: every session has its own frame', async () => {
    const { manager, hook, cameraY } = await inSession();
    for (let i = 0; i < 12; i++) hook.onReticle?.(flat(cameraY - 1.2));
    hook.onStateChange?.(false);
    expect(manager.xrFloorY(), 'out of the session').toBeUndefined();
    hook.onStateChange?.(true);
    expect(manager.xrFloorY(), 'in the next one').toBeUndefined();
  });
});
