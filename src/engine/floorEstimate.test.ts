import { describe, expect, it } from 'vitest';
import { FloorEstimate, floorFit, MIN_DROP_M } from './floorEstimate';
import type { Pose } from './types';

const flat = (y: number): Pose => ({ position: [0, y, -1], rotation: [0, 0, 0, 1] });
/** A wall: its normal along +Z, a quarter turn about X. */
const wall = (y: number): Pose => ({ position: [0, y, -1], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
const feed = (f: FloorEstimate, y: number, n: number, cameraY = 1.5, pose = flat) => {
  for (let i = 0; i < n; i++) f.addHit(pose(y + (i % 3) * 0.005), cameraY);
};

describe('the floor, from surface hits', () => {
  it('is unknown until a low surface has been seen a few times', () => {
    const f = new FloorEstimate();
    feed(f, 0.26, 3);
    expect(f.floorY).toBeUndefined();
    feed(f, 0.26, 10);
    expect(f.floorY).toBeCloseTo(0.265, 2);
  });

  it('is the lowest surface seen, not the most seen', () => {
    const f = new FloorEstimate();
    feed(f, 0.45, 60);             // a low table, aimed at for a long time
    feed(f, 0.19, 12);             // the floor, glimpsed
    expect(f.floorY).toBeCloseTo(0.195, 2);
  });

  it('never takes the shelf\'s own top for it: too close below the phone', () => {
    const f = new FloorEstimate();
    // A 4x2 KALLAX top at 0.77 with the phone at 1.4: 0.63 m down.
    feed(f, 0.77, 50, 1.4);
    expect(1.4 - 0.77).toBeLessThan(MIN_DROP_M);
    expect(f.floorY).toBeUndefined();
  });

  it('ignores walls and the shelf front', () => {
    const f = new FloorEstimate();
    feed(f, 0.1, 50, 1.5, wall);
    expect(f.floorY).toBeUndefined();
  });

  it('ignores a single stray hit below the floor', () => {
    const f = new FloorEstimate();
    feed(f, 0.26, 20);
    feed(f, -0.4, 2);
    expect(f.floorY).toBeCloseTo(0.265, 2);
  });

  it('starts over with a new session', () => {
    const f = new FloorEstimate();
    feed(f, 0.26, 20);
    f.reset();
    expect(f.floorY).toBeUndefined();
  });
});

describe('a recognised base against the floor', () => {
  // The two device sessions: a 4x2 (row pitch 0.37 m) locked a row high, a
  // 4x4 (0.36 m) a row low, each with the floor the operator tapped.
  it('moves a lock a row too high down onto the floor', () => {
    expect(floorFit(0.648, 0.259, 0.37)).toEqual({ rows: 1 });
  });

  it('moves a lock a row too low up onto it', () => {
    expect(floorFit(-0.198, 0.187, 0.36)).toEqual({ rows: -1 });
  });

  it('leaves a base on the floor alone', () => {
    expect(floorFit(0.286, 0.259, 0.37)).toEqual({ rows: 0 });
    expect(floorFit(0.2, 0.187, 0.36)).toEqual({ rows: 0 });
  });

  it('says no fit for a base that no single row puts on the floor', () => {
    // The session's bad bursts: 24 cm up, at 0.54 confidence.
    expect(floorFit(0.496, 0.259, 0.37)).toBeUndefined();
    expect(floorFit(1.0, 0.259, 0.37), 'two rows up').toBeUndefined();
  });
});
