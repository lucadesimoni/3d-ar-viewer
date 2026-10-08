import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { gearbox } from '../../data';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Outline width of a part in error, sampled at two moments of the pulse. */
async function widths(reduce: boolean): Promise<[number, number]> {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce'), media: q }));
  const { SceneManager } = await import('./SceneManager');
  const manager = new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });
  const id = gearbox.parts[0].id;
  const state = {
    placements: new Map(), severityByPart: new Map([[id, 'error']]), selectedPartId: undefined,
    activePartIds: new Set<string>(), explodeFactor: 0, showBackground: true, showGhosts: true,
    recognitionByPart: new Map(),
  } as never;
  const mesh = () => (manager as unknown as { parts: Map<string, { mesh: { outlineWidth: number } }> }).parts.get(id)!.mesh;
  const now = vi.spyOn(performance, 'now');
  const sample = (t: number): number => { now.mockReturnValue(t); manager.update(state); return mesh().outlineWidth; };
  const result: [number, number] = [sample(100_000), sample(100_250)];
  manager.dispose();
  return result;
}

describe('the attention pulse on a part in error', () => {
  it('pulses by default', async () => {
    const [a, b] = await widths(false);
    expect(a).not.toBeCloseTo(b, 6);
  });
  it('holds still when the device asks for less motion', async () => {
    const [a, b] = await widths(true);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeCloseTo(b, 9);
  });
});
