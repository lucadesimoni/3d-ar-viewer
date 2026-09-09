import { describe, expect, it } from 'vitest';
import { SETTLE_FRAMES, SETTLE_TIMEOUT_MS, createSettleTracker } from './settle';

const feed = (
  t: ReturnType<typeof createSettleTracker>,
  n: number,
  sample: { emulated: boolean; hasHit: boolean },
  from = 0,
  stepMs = 16,
) => {
  let state = t.state();
  for (let i = 0; i < n; i++) state = t.sample(sample, from + i * stepMs);
  return state;
};

const tracked = { emulated: false, hasHit: true };

describe('when the platform is ready to be placed against', () => {
  it('holds placement back while the device is still guessing where it is', () => {
    const t = createSettleTracker();
    t.reset(0);
    // A tracked pose but no surface yet, for a full second: not settled.
    const state = feed(t, 60, { emulated: false, hasHit: false }, 0);
    expect(state.ready).toBe(false);
    expect(state.reason).toBe('settling');
    expect(state.goodFrames).toBe(0);
  });

  it('arms after a run of frames with a real pose and a surface', () => {
    const t = createSettleTracker();
    t.reset(0);
    expect(feed(t, SETTLE_FRAMES - 1, tracked, 0).ready).toBe(false);
    expect(t.sample(tracked, SETTLE_FRAMES * 16).ready).toBe(true);
    expect(t.state().reason).toBe('settled');
  });

  it('counts consecutively, so a device that is hunting never qualifies', () => {
    const t = createSettleTracker();
    t.reset(0);
    for (let i = 0; i < 200; i++) {
      // Every third frame finds a surface: plenty cumulatively, never a run.
      t.sample({ emulated: false, hasHit: i % 3 === 0 }, i * 16);
    }
    expect(t.state().reason).toBe('settling');
    expect(t.state().ready).toBe(false);
  });

  it('gives up waiting rather than trapping the operator', () => {
    const t = createSettleTracker();
    t.reset(0);
    const before = t.sample({ emulated: true, hasHit: false }, SETTLE_TIMEOUT_MS - 1);
    expect(before.ready).toBe(false);
    const after = t.sample({ emulated: true, hasHit: false }, SETTLE_TIMEOUT_MS);
    expect(after.ready).toBe(true);
    // And says so: placing on the clock is not the same as placing on tracking.
    expect(after.reason).toBe('timeout');
  });

  it('stays armed when tracking dips, having once settled', () => {
    const t = createSettleTracker();
    t.reset(0);
    feed(t, SETTLE_FRAMES, tracked, 0);
    expect(t.state().reason).toBe('settled');
    // The operator turns towards a blank wall while aiming. Taking the tap away
    // from them at that moment would be worse than the noise it saves.
    const dipped = feed(t, 30, { emulated: false, hasHit: false }, 5000);
    expect(dipped.ready).toBe(true);
    expect(dipped.reason).toBe('settled');
    expect(dipped.hasHit).toBe(false);
  });

  it('starts over for a new session', () => {
    const t = createSettleTracker();
    t.reset(0);
    feed(t, SETTLE_FRAMES, tracked, 0);
    expect(t.state().ready).toBe(true);
    t.reset(60_000);
    expect(t.state().ready).toBe(false);
    // And the clock restarts with it: the old session's minute is not a timeout.
    expect(t.sample({ emulated: true, hasHit: false }, 60_016).reason).toBe('settling');
  });
});
