import { beforeEach, describe, expect, it } from 'vitest';
import { anchorWorthLogging, samePresence, useStore, type PartPresence } from './store';
import { logEntries } from '../diagnostics/log';

const pose = (x: number) => ({ position: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true);
});

describe('presence readings that say nothing new', () => {
  const reading = (coverage: number): Record<string, PartPresence> => ({ a: { state: 'present', reasons: [], coverage } });

  it('do not replace what the guide is showing', () => {
    useStore.getState().setPartPresence(reading(0.5));
    const before = useStore.getState().partPresence;
    useStore.getState().setPartPresence(reading(0.503));
    expect(useStore.getState().partPresence).toBe(before);
  });

  it('but a change of state, reason or coverage does', () => {
    expect(samePresence(reading(0.5), reading(0.52))).toBe(false);
    expect(samePresence(reading(0.5), { a: { state: 'absent', reasons: [], coverage: 0.5 } })).toBe(false);
    expect(samePresence(reading(0.5), { a: { state: 'present', reasons: ['blurry'], coverage: 0.5 } })).toBe(false);
    expect(samePresence(reading(0.5), {})).toBe(false);
    expect(samePresence({}, {})).toBe(true);
  });
});

describe('the diagnostics log under frame-rate tracking', () => {
  it('records the placement once, not once per tracked frame', () => {
    const count = () => logEntries().filter((e) => e.message === 'anchor set').length;
    const start = count();
    for (let i = 0; i < 60; i++) useStore.getState().setAnchor(pose(1 + i * 0.0001), 0.8, 'recognized');
    expect(count() - start).toBe(1);
    // …while the store itself still follows every frame.
    expect(useStore.getState().anchor?.position[0]).toBeCloseTo(1.0059, 4);
  });

  it('a real move, a new kind of placement, a quality change or a clear is logged', () => {
    expect(anchorWorthLogging(undefined, pose(0), 0.5, 'manual')).toBe(true);
    const last = { pose: pose(0), quality: 0.5, placement: 'manual' };
    expect(anchorWorthLogging(last, pose(0.005), 0.52, 'manual')).toBe(false);
    expect(anchorWorthLogging(last, pose(0.03), 0.5, 'manual')).toBe(true);
    expect(anchorWorthLogging(last, pose(0), 0.5, 'recognized')).toBe(true);
    expect(anchorWorthLogging(last, pose(0), 0.65, 'manual')).toBe(true);
    expect(anchorWorthLogging(last, undefined, 0, 'manual')).toBe(true);
  });
});
