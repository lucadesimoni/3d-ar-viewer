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
