import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';
import type { Scene } from '@babylonjs/core/scene';

const prepare = vi.hoisted(() => vi.fn());
// The whole module surface, not just the entry point: `xrSessionInfo` reads the
// session's own account of itself from these, and a namespace missing them
// throws rather than yielding undefined — which the report would then swallow.
vi.mock('./xr', () => ({
  prepareImmersiveAr: prepare,
  lastXrError: undefined,
  referenceSpace: undefined,
  grantedFeatures: [],
  cameraAccess: { requested: false, granted: false },
  tracking: undefined,
}));

afterEach(() => vi.restoreAllMocks());

describe('prepared XR callback ownership', () => {
  it('rebinds placement and exit callbacks when a failed entry is retried', async () => {
    const hooks: XrHooks[] = [];
    const ended = vi.fn(async () => {});
    prepare.mockImplementation(async (_scene: Scene, _overlay: HTMLElement, callbacks: XrHooks) => {
      hooks.push(callbacks);
      const succeeds = hooks.length > 1;
      return { enter: async () => succeeds ? { end: ended } : undefined, dispose: vi.fn() };
    });
    const manager = new SceneManager(document.createElement('canvas'), gearbox, {}, {
      engine: new NullEngine(), kind: 'webgl',
      perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
    });
    try {
      const initialPlace = vi.fn();
      const initialEnd = vi.fn();
      const failedPlace = vi.fn();
      const failedEnd = vi.fn();
      await manager.prepareWebXr({ onPlace: initialPlace, onEnd: initialEnd });
      expect(await manager.startWebXr(failedPlace, failedEnd)).toBeUndefined();
      await vi.waitFor(() => expect(manager.xrReady()).toBe(true));
      const retryPlace = vi.fn();
      const retryEnd = vi.fn();
      expect(await manager.startWebXr(retryPlace, retryEnd)).toBeDefined();
      vi.spyOn(performance, 'now').mockReturnValue(1000);
      manager.setPlacementActive(true);
      vi.mocked(performance.now).mockReturnValue(2000);
      hooks[1].onSelectAnchor?.({ position: [0, 0, 2], rotation: [0, 0, 0, 1] });
      hooks[1].onStateChange?.(false);
      expect(retryPlace).toHaveBeenCalledTimes(1);
      expect(retryEnd).toHaveBeenCalledTimes(1);
      expect(initialPlace).not.toHaveBeenCalled();
      expect(initialEnd).not.toHaveBeenCalled();
      expect(failedPlace).not.toHaveBeenCalled();
      expect(failedEnd).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });
});

describe('why real AR is not running', () => {
  const manager = () => new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });

  it('waits for a build that is still running instead of losing the tap to it', async () => {
    // The helper is built ahead of the tap because `requestSession` needs the
    // tap's activation. On a cold load that race can be lost, and losing it used
    // to drop the operator on the camera path without a word.
    const ended = vi.fn(async () => {});
    prepare.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { enter: async () => ({ end: ended }), dispose: vi.fn() };
    });
    const m = manager();
    try {
      const building = m.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
      expect(m.xrReady()).toBe(false);
      expect(await m.startWebXr(vi.fn(), vi.fn())).toBeDefined();
      await building;
    } finally {
      m.dispose();
    }
  });

  it('builds once however many callers ask for it', async () => {
    prepare.mockClear();
    prepare.mockImplementation(async () => ({ enter: async () => undefined, dispose: vi.fn() }));
    const m = manager();
    try {
      const hooks = { onPlace: vi.fn(), onEnd: vi.fn() };
      await Promise.all([m.prepareWebXr(hooks), m.prepareWebXr(hooks), m.prepareWebXr(hooks)]);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      m.dispose();
    }
  });

  it('says the tap outran the loading rather than blaming the device', async () => {
    prepare.mockImplementation(async () => ({ enter: async () => undefined, dispose: vi.fn() }));
    const m = manager();
    try {
      // AR entered before the helper existed: nothing was refused because
      // nothing was asked, and the operator only has to press again.
      expect(await m.startWebXr(vi.fn(), vi.fn())).toBeUndefined();
      expect(await m.xrFailure()).toMatch(/before WebXR had finished loading/);
      await vi.waitFor(() => expect(m.xrReady()).toBe(true));
      // A real attempt was made this time; the reason must come from it.
      expect(await m.startWebXr(vi.fn(), vi.fn())).toBeUndefined();
      expect(await m.xrFailure()).toBeUndefined();
    } finally {
      m.dispose();
    }
  });
});

describe('the watchdog and a live session', () => {
  const manager = () => new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });

  it('does not switch a session to a timer clock when frames pause', async () => {
    vi.useFakeTimers();
    prepare.mockImplementation(async () => ({
      enter: async () => ({ end: async () => {} }), dispose: vi.fn(),
    }));
    const m = manager();
    try {
      await m.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
      expect(await m.startWebXr(vi.fn(), vi.fn())).toBeDefined();
      // Babylon reports IN_XR on the session's first frame; the manager is in
      // a session from here, and Babylon owns the loop.
      (prepare.mock.calls.at(-1)![2] as XrHooks).onStateChange!(true);
      // No frames for ten watchdog intervals — ARCore starting, or a slow
      // first frame. Rescuing this with a `setInterval` renders into the page
      // canvas instead of the session, which is a black passthrough.
      vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
      await vi.advanceTimersByTimeAsync(20000);
      expect(m.renderStats().clock).toBe('raf');
      expect(m.renderStats().stalls).toBe(0);
    } finally {
      m.dispose();
      vi.useRealTimers();
    }
  });

  it('takes a stalled loop back off the timer before handing it to a session', async () => {
    vi.useFakeTimers();
    prepare.mockImplementation(async () => ({
      enter: async () => ({ end: async () => {} }), dispose: vi.fn(),
    }));
    const m = manager();
    try {
      // A genuine stall before AR: animation frames stop coming, the watchdog
      // moves the loop onto a timer, and a timer cannot drive an XR session.
      vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
      m.restartRenderLoop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(m.renderStats().clock).toBe('timer');
      await m.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
      expect(await m.startWebXr(vi.fn(), vi.fn())).toBeDefined();
      expect(m.renderStats().clock).toBe('raf');
    } finally {
      m.dispose();
      vi.useRealTimers();
    }
  });
});

describe('an anchored assembly when the operator walks around it', () => {
  const manager = () => new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });
  const yawOf = (m: SceneManager) => {
    const root = m.scene.getTransformNodeByName('assembly')!;
    const q = root.rotationQuaternion!;
    return (Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)) * 180) / Math.PI;
  };

  it('keeps the heading it was placed with, however the operator moves', async () => {
    prepare.mockImplementation(async () => ({
      enter: async () => ({ end: async () => {} }), dispose: vi.fn(),
    }));
    const m = manager();
    try {
      // The app's controller is what puts a placed pose into the scene; stand
      // in for it, so this measures the scene and not a spy.
      const place = (pose: Parameters<SceneManager['setAnchor']>[0]) => m.setAnchor(pose);
      await m.prepareWebXr({ onPlace: place, onEnd: vi.fn() });
      expect(await m.startWebXr(place, vi.fn())).toBeDefined();
      const hooks = prepare.mock.calls.at(-1)![2] as XrHooks;
      hooks.onStateChange!(true);
      vi.spyOn(performance, 'now').mockReturnValue(1000);
      m.setPlacementActive(true);
      vi.mocked(performance.now).mockReturnValue(2000);

      // Placed on a surface two metres ahead. It turns to face the operator —
      // right once, at the tap.
      const surface = { position: [0, 0, 2] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
      hooks.onSelectAnchor!(surface);
      const placed = yawOf(m);

      // The operator walks round to the far side. The platform re-reports the
      // same spot — nothing about the world changed.
      m.scene.activeCamera!.position.set(0, 1.6, 4);
      hooks.onAnchorPose!(surface);
      hooks.onAnchorPose!(surface);
      expect(yawOf(m)).toBeCloseTo(placed, 4);

      // A real correction, though, has to be followed: the same spot, found to
      // be 5 cm further on and turned by ten degrees.
      const turned = Math.sin((10 * Math.PI) / 180 / 2);
      hooks.onAnchorPose!({ position: [0.05, 0, 2], rotation: [0, turned, 0, Math.cos((10 * Math.PI) / 180 / 2)] });
      // A correction is followed over a few frames rather than teleported to,
      // so let the picture catch up before reading the heading off it.
      for (let i = 0; i < 40; i++) m.scene.render();
      // Compared as an angle: 188° and −172° are the same heading.
      const turnedBy = ((yawOf(m) - placed + 540) % 360) - 180;
      expect(turnedBy).toBeCloseTo(10, 2);
      const root = m.scene.getTransformNodeByName('assembly')!;
      expect(root.position.x).not.toBeCloseTo(0, 3);
    } finally {
      m.dispose();
    }
  });
});

describe('what the report can still say after the session has gone', () => {
  it('keeps the tracking state a finished session ended on', async () => {
    const hooks: XrHooks[] = [];
    prepare.mockImplementation(async (_s: Scene, _o: HTMLElement, callbacks: XrHooks) => {
      hooks.push(callbacks);
      return { enter: async () => ({ end: vi.fn(async () => {}) }), dispose: vi.fn() };
    });
    const m = new SceneManager(document.createElement('canvas'), gearbox, {}, {
      engine: new NullEngine(), kind: 'webgl',
      perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
    });
    try {
      const seen: (unknown)[] = [];
      m.onXrTracking((state) => seen.push(state));
      await m.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
      await m.startWebXr(vi.fn(), vi.fn());
      const hook = hooks[hooks.length - 1];
      hook.onStateChange?.(true);
      hook.onTracking?.({
        ready: true, reason: 'timeout', goodFrames: 3, emulated: true, hasHit: false, waitedMs: 8000,
      });
      hook.onStateChange?.(false);
      // The HUD is told the session is over and stops saying anything about it.
      expect(seen[seen.length - 1]).toBeUndefined();
      // The report is not: "it took eight seconds and never settled" is the
      // answer to the question the report gets written to ask.
      const info = await m.xrSessionInfo();
      expect(info.tracking?.reason).toBe('timeout');
      expect(info.tracking?.waitedMs).toBe(8000);
    } finally {
      m.dispose();
    }
  });
});

describe('going back into AR after leaving it', () => {
  it('has a helper ready for the second entry, instead of falling back', async () => {
    // Straight out of a device log: a session at 77 s, "AR started before
    // WebXR had finished loading" at 159 s, camera passthrough, and a real
    // session again only after a third press. Entering moved the helper out of
    // `xrPrepared` and nothing ever put one back, so the second entry of every
    // page load found nothing prepared — on any device, every time.
    let built = 0;
    const hooks: XrHooks[] = [];
    prepare.mockImplementation(async (_s: Scene, _o: HTMLElement, callbacks: XrHooks) => {
      built++;
      hooks.push(callbacks);
      return { enter: async () => ({ end: vi.fn(async () => {}) }), dispose: vi.fn() };
    });
    const m = new SceneManager(document.createElement('canvas'), gearbox, {}, {
      engine: new NullEngine(), kind: 'webgl',
      perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
    });
    try {
      await m.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
      expect(m.xrReady()).toBe(true);
      expect(await m.startWebXr(vi.fn(), vi.fn())).toBeDefined();
      // In session: nothing is prepared, because the helper is in use and a
      // second tap must not enter it twice.
      expect(m.xrReady()).toBe(false);

      hooks[0].onStateChange?.(true);
      hooks[0].onStateChange?.(false);
      // Out of the session, and ready again without building anything new.
      expect(m.xrReady()).toBe(true);
      expect(built).toBe(1);

      const second = vi.fn();
      expect(await m.startWebXr(second, vi.fn())).toBeDefined();
      expect(await m.xrFailure()).toBeUndefined();
    } finally {
      m.dispose();
    }
  });
});
