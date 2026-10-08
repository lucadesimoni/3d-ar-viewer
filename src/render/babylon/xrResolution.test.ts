import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { HardwareScalingOptimization } from '@babylonjs/core/Misc/sceneOptimizer';
import { logEntries } from '../../diagnostics/log';

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

describe('what the log says about a session', () => {
  const jumps = () => logEntries().filter((e) => e.message === 'camera jumped');

  it('notes the room being re-based, and not someone walking', async () => {
    const { manager } = await inSession();
    const m = manager as unknown as {
      scene: { activeCamera: unknown };
      watchXrCamera: (now: number) => void;
      lastXrCamera: unknown;
      xrTracking: { ready: boolean } | undefined;
    };
    const real = m.scene.activeCamera;
    const at = (x: number, t: number) => {
      m.scene.activeCamera = { globalPosition: new Vector3(x, 1.2, 0) };
      m.watchXrCamera(t);
    };
    try {
      const before = jumps().length;
      // A session starting: the pose sits at the origin until the floor height
      // arrives — the false "jumped 1.235 m" of the first log with this entry.
      m.xrTracking = { ready: false };
      m.scene.activeCamera = { globalPosition: new Vector3(0, 0, 0) };
      m.watchXrCamera(900);
      m.scene.activeCamera = { globalPosition: new Vector3(0, 1.235, 0) };
      m.watchXrCamera(928);
      expect(jumps().length - before).toBe(0);
      m.xrTracking = { ready: true };
      at(0, 1000);
      at(0.06, 1042);            // walking briskly: 1.4 m/s
      at(0.36, 1442);            // a dropped frame: far, but slow
      at(3.4, 2400);             // after a pause (the system UI was up): 3 m in
                                 // just under a second is fast, but not comparable
      expect(jumps().length - before).toBe(0);
      at(4.37, 2433);            // the 0.97 m a device log could not explain
      expect(jumps().length - before).toBe(1);
      expect(jumps().at(-1)?.data).toMatchObject({ byM: 0.97, inMs: 33 });
    } finally {
      m.scene.activeCamera = real;
      manager.dispose();
    }
  });

  it('says when the resolution was lowered, and when it was given back', async () => {
    const { manager, m, hooks } = await inSession();
    const opt = m.optimizer as unknown as { onNewOptimizationAppliedObservable: { notifyObservers: (o: unknown) => void } };
    const said = (msg: string) => logEntries().filter((e) => e.message === msg).length;
    try {
      const lowered = said('resolution lowered');
      opt.onNewOptimizationAppliedObservable.notifyObservers(new HardwareScalingOptimization(2, 1, 0.25));
      expect(said('resolution lowered') - lowered).toBe(1);

      await manager.startWebXr(vi.fn(), vi.fn());
      const hook = hooks[hooks.length - 1];
      hook.onStateChange?.(true);
      vi.spyOn(NullEngine.prototype, 'getHardwareScalingLevel').mockReturnValue(1);
      const restored = said('resolution restored');
      hook.onStateChange?.(false);
      expect(said('resolution restored') - restored).toBe(1);
    } finally {
      manager.dispose();
    }
  });
});
