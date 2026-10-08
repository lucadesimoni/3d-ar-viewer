import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';

afterEach(() => vi.restoreAllMocks());

type Internals = {
  renderFrame: () => void;
  scene: { render: () => void; isReady: () => boolean };
  camera: { inertialAlphaOffset: number };
  arMode: boolean;
};

function harness() {
  const now = vi.spyOn(performance, 'now').mockReturnValue(10_000);
  const manager = new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });
  const m = manager as unknown as Internals;
  vi.spyOn(m.scene, 'isReady').mockReturnValue(true);
  const render = vi.spyOn(m.scene, 'render').mockImplementation(() => undefined);
  /** Run `n` loop ticks starting at time `t`, 16 ms apart; returns how many drew. */
  const ticks = (t: number, n = 5): number => {
    render.mockClear();
    for (let i = 0; i < n; i++) { now.mockReturnValue(t + i * 16); m.renderFrame(); }
    return render.mock.calls.length;
  };
  const state = {
    placements: new Map(), severityByPart: new Map(), selectedPartId: undefined,
    activePartIds: new Set<string>(), explodeFactor: 0, showBackground: true, showGhosts: true,
    recognitionByPart: new Map(),
  } as never;
  return { manager, m, ticks, now, state };
}

describe('the studio view while nothing changes', () => {
  it('stops drawing once the scene has settled, and the loop keeps ticking', () => {
    const { manager, ticks } = harness();
    expect(ticks(10_000), 'right after a change it draws').toBe(5);
    expect(ticks(20_000), 'at most the one frame that finds it settled').toBeLessThanOrEqual(1);
    const before = manager.renderStats().frames;
    expect(ticks(21_000), 'after that, nothing to draw').toBe(0);
    expect(manager.renderStats().frames - before, 'but the loop is alive').toBe(5);
    expect(manager.renderStats().idleFrames).toBeGreaterThanOrEqual(5);
    manager.dispose();
  });

  it('draws again on any change to what it shows', () => {
    const { manager, ticks, now, state } = harness();
    ticks(20_000);
    now.mockReturnValue(30_000);
    manager.update(state);
    expect(ticks(30_000)).toBe(5);
    manager.dispose();
  });

  it('keeps drawing while the camera coasts after a drag', () => {
    const { manager, m, ticks } = harness();
    m.camera.inertialAlphaOffset = 0.01;
    expect(ticks(20_000)).toBe(5);
    m.camera.inertialAlphaOffset = 0;
    ticks(21_000);
    expect(ticks(22_000), 'still once it has coasted to a stop').toBe(0);
    manager.dispose();
  });

  it('keeps drawing until the scene reports ready', () => {
    const { manager, m, ticks } = harness();
    vi.mocked(m.scene.isReady).mockReturnValue(false);
    expect(ticks(20_000)).toBe(5);
    vi.mocked(m.scene.isReady).mockReturnValue(true);
    expect(ticks(21_000)).toBe(1);   // the frame that finds it ready draws; then it stops
    manager.dispose();
  });

  it('never stops in AR, where the camera moves under the overlay', () => {
    const { manager, m, ticks } = harness();
    m.arMode = true;
    expect(ticks(20_000)).toBe(5);
    manager.dispose();
  });
});
