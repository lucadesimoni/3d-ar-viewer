import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';
import type { Scene } from '@babylonjs/core/scene';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./xr', () => ({ prepareImmersiveAr: prepare }));

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
