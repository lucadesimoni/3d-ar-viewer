import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./xr', () => ({ prepareImmersiveAr: prepare }));

afterEach(() => vi.restoreAllMocks());

async function inSession() {
  const hooks: XrHooks[] = [];
  prepare.mockImplementation(async (_s: unknown, _o: unknown, callbacks: XrHooks) => {
    hooks.push(callbacks);
    return { enter: async () => ({ end: vi.fn(async () => {}) }), dispose: vi.fn() };
  });
  const manager = new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });
  await manager.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
  await manager.startWebXr(vi.fn(), vi.fn());
  return { manager, hook: hooks[hooks.length - 1] };
}

/** Enough of a texture to be a distinct thing the manager can hold. */
const fakeTexture = (): BaseTexture => ({
  getSize: () => ({ width: 886, height: 1920 }),
}) as unknown as BaseTexture;

describe('where the picture comes from, said out loud', () => {
  it('names the three cases apart, because they need three different fixes', async () => {
    // `xr-blind` is the one worth having: a session that will not hand its
    // camera over looks, from every other number in the report, exactly like a
    // session that does. That is the iPad clip, and until now it was also
    // every session — the vision loop did not run in one at all.
    const { manager, hook } = await inSession();
    try {
      expect(manager.renderStats().frameSource).toBe('video');
      expect(manager.hasXrCameraFrame).toBe(false);

      hook.onStateChange?.(true);
      expect(manager.renderStats().frameSource).toBe('xr-blind');

      hook.onCameraTexture?.(fakeTexture());
      expect(manager.renderStats().frameSource).toBe('xr-raw');
      expect(manager.hasXrCameraFrame).toBe(true);

      // The feature disposes its textures on detach; holding one past that is
      // holding a handle that throws.
      hook.onCameraTexture?.(undefined);
      expect(manager.renderStats().frameSource).toBe('xr-blind');
      expect(manager.hasXrCameraFrame).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it('records the session\u2019s own field of view, not the passthrough crop', async () => {
    // A capture is evidence only if it can be re-projected later, and that
    // needs the lens it was taken through. A device log carried `fovDeg: 49`
    // in its captures while the same report said the session measured 72.18:
    // `visibleFovDeg` is the assumed 60 degrees narrowed by the `object-fit:
    // cover` crop of a video element that does not exist in a session.
    const { manager, hook } = await inSession();
    try {
      const passthrough = manager.cameraPose().fovDeg;
      hook.onStateChange?.(true);
      // In a session Babylon's XR camera carries the platform's own angle.
      manager.scene.activeCamera!.fov = (72.18 * Math.PI) / 180;
      expect(manager.cameraPose().fovDeg).toBeCloseTo(72.18, 1);
      expect(manager.cameraPose().fovDeg).not.toBeCloseTo(passthrough, 1);
      // And it agrees with what the rest of the report says about the session.
      expect(manager.renderStats().fovDeg).toBeCloseTo(manager.cameraPose().fovDeg, 1);
    } finally {
      manager.dispose();
    }
  });

  it('reports no readback cost until there has been a readback', async () => {
    const { manager, hook } = await inSession();
    try {
      hook.onStateChange?.(true);
      hook.onCameraTexture?.(fakeTexture());
      expect(manager.cameraFrameCost()).toBeUndefined();
      expect(manager.renderStats().frameReadbackMs).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });
});
