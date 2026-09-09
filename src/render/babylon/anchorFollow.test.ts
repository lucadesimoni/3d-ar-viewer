import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';
import type { Pose } from '../../engine/types';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./xr', () => ({ prepareImmersiveAr: prepare }));

afterEach(() => vi.restoreAllMocks());

const at = (x: number, y: number, z: number): Pose => ({
  position: [x, y, z], rotation: [0, 0, 0, 1],
});

/** A manager in a session with a placement made, and the hooks that drive it. */
async function placed() {
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
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  manager.setPlacementActive(true);
  vi.mocked(performance.now).mockReturnValue(5000);
  hook.onSelectAnchor?.(at(0, 0, 2));
  return { manager, hook };
}

describe('following the platform without shaking on its noise', () => {
  it('ignores reports that say the anchor is where it already was', async () => {
    const { manager, hook } = await placed();
    try {
      // Straight from the Android log: ~30 reports a second, the position
      // identical to three decimals for seconds at a time. Each one used to be
      // written through as a fresh placement.
      hook.onAnchorPose?.(at(-0.132, -0.781, 1.597));
      const setAnchor = vi.spyOn(manager, 'setAnchor');
      for (let i = 0; i < 60; i++) hook.onAnchorPose?.(at(-0.132, -0.781, 1.597));
      expect(setAnchor).not.toHaveBeenCalled();

      // And the 1.19 m relocalisation at t=34454 goes through at once.
      hook.onAnchorPose?.(at(-1.172, -0.185, 1.979));
      expect(setAnchor).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });

  it('moves the assembly by the anchor motion, not by the anchor position', async () => {
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(at(-0.132, -0.781, 1.597));
      const setAnchor = vi.spyOn(manager, 'setAnchor');
      hook.onAnchorPose?.(at(-1.172, -0.185, 1.979));
      // Placed at z = 2; the anchor moved by (-1.04, +0.596, +0.382).
      const moved = setAnchor.mock.calls[0][0] as Pose;
      expect(moved.position[0]).toBeCloseTo(-1.04, 3);
      expect(moved.position[1]).toBeCloseTo(0.596, 3);
      expect(moved.position[2]).toBeCloseTo(2.382, 3);
    } finally {
      manager.dispose();
    }
  });

  it('starts measuring afresh at each new placement', async () => {
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(at(0, 0, 2));
      hook.onAnchorPose?.(at(0.5, 0, 2));
      // A second placement: the old anchor's travel must not be replayed onto it.
      vi.mocked(performance.now).mockReturnValue(9000);
      manager.setPlacementActive(true);
      vi.mocked(performance.now).mockReturnValue(13000);
      hook.onSelectAnchor?.(at(0, 0, 3));
      const setAnchor = vi.spyOn(manager, 'setAnchor');
      hook.onAnchorPose?.(at(0.5, 0, 2));
      expect(setAnchor).not.toHaveBeenCalled();
      hook.onAnchorPose?.(at(0.5, 0, 2.0005));
      expect(setAnchor).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });
});
