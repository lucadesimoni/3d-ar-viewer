import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./xr', () => ({ prepareImmersiveAr: prepare }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Internals = { optimizer?: { _isRunning: boolean }; baseScalingLevel: number };

async function inSession() {
  vi.stubGlobal('devicePixelRatio', 3);
  // The null engine keeps no scaling level, so watch what is asked of it.
  const scaling = vi.spyOn(NullEngine.prototype, 'setHardwareScalingLevel');
  const hooks: XrHooks[] = [];
  prepare.mockImplementation(async (_s: unknown, _o: unknown, callbacks: XrHooks) => {
    hooks.push(callbacks);
    return { enter: async () => ({ end: vi.fn(async () => {}) }), dispose: vi.fn() };
  });
  const manager = new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'high', antialias: false, adaptive: true, maxPixelRatio: 3, targetFps: 60, recognitionIntervalMs: 400 },
  });
  const m = manager as unknown as Internals;
  await manager.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
  return { manager, m, hooks, scaling };
}

describe('resolution across a WebXR session', () => {
  it('is not judged while a session owns the display, and is restored afterwards', async () => {
    const { manager, m, hooks, scaling } = await inSession();
    try {
      const full = m.baseScalingLevel;
      expect(full, 'a dpr-3 phone renders at device pixels').toBeCloseTo(1 / 3, 6);
      expect(m.optimizer?._isRunning, 'judging the studio view').toBe(true);

      await manager.startWebXr(vi.fn(), vi.fn());
      const hook = hooks[hooks.length - 1];
      hook.onStateChange?.(true);
      expect(m.optimizer?._isRunning, 'paused for the session').toBe(false);

      // What the device log showed: degraded to CSS pixels during the session.
      scaling.mockClear();
      hook.onStateChange?.(false);
      expect(scaling.mock.calls.at(-1)?.[0], 'full resolution again').toBeCloseTo(full, 6);
      expect(m.optimizer?._isRunning, 'and judged afresh').toBe(true);
    } finally {
      manager.dispose();
    }
  });
});
