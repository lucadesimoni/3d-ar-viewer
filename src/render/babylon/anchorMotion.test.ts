import { describe, expect, it } from 'vitest';
import type { Pose } from '../../engine/types';
import {
  ANCHOR_POSITION_EPS_M,
  anchorMoved,
  angleBetween,
  distanceBetween,
} from './anchorMotion';

const at = (x: number, y: number, z: number): Pose => ({
  position: [x, y, z], rotation: [0, 0, 0, 1],
});

/** A turn of `deg` about the vertical, as a quaternion. */
const yaw = (deg: number): Pose => {
  const h = ((deg * Math.PI) / 180) / 2;
  return { position: [0, 0, 0], rotation: [0, Math.sin(h), 0, Math.cos(h)] };
};

describe('which anchor corrections are worth applying', () => {
  it('discards the sub-millimetre noise the device log is full of', () => {
    // Straight from the log: the same spot, reported again to three decimals.
    const applied = at(-1.164, -0.207, 1.96);
    expect(anchorMoved(applied, at(-1.164, -0.207, 1.96))).toBe(false);
    expect(anchorMoved(applied, at(-1.1643, -0.2072, 1.9601))).toBe(false);
  });

  it('lets the relocalisation jump through on the frame it arrives', () => {
    // t=34454 in the same log: 1.19 m in one report, and the anchor absorbed it.
    const before = at(-0.132, -0.781, 1.597);
    const after = at(-1.172, -0.185, 1.979);
    expect(distanceBetween(before.position, after.position)).toBeGreaterThan(1.1);
    expect(anchorMoved(before, after)).toBe(true);
  });

  it('applies a move as small as the threshold and no smaller', () => {
    const applied = at(0, 0, 0);
    expect(anchorMoved(applied, at(ANCHOR_POSITION_EPS_M, 0, 0))).toBe(true);
    expect(anchorMoved(applied, at(ANCHOR_POSITION_EPS_M * 0.9, 0, 0))).toBe(false);
  });

  it('sees a turn on the spot, which no position test would catch', () => {
    expect(anchorMoved(yaw(0), yaw(0.05))).toBe(false);
    expect(anchorMoved(yaw(0), yaw(2))).toBe(true);
    expect(angleBetween(yaw(0).rotation, yaw(90).rotation)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('reads a quaternion and its negation as the same orientation', () => {
    const q = yaw(30);
    const flipped: Pose = { position: [0, 0, 0], rotation: q.rotation.map((v) => -v) as Pose['rotation'] };
    expect(angleBetween(q.rotation, flipped.rotation)).toBeCloseTo(0, 6);
    expect(anchorMoved(q, flipped)).toBe(false);
  });

  it('does not let a steady drift creep past unapplied', () => {
    // A tenth of a millimetre a frame is below the threshold every single time.
    // Measured against the last *applied* pose it still adds up and gets through;
    // measured against the last *reported* pose it never would, and the assembly
    // would walk away from its spot with no correction ever recorded.
    let applied = at(0, 0, 0);
    let applications = 0;
    for (let i = 1; i <= 120; i++) {
      const reported = at(i * 0.0001, 0, 0);
      if (anchorMoved(applied, reported)) { applied = reported; applications++; }
    }
    expect(applications).toBe(6);
    expect(applied.position[0]).toBeCloseTo(0.012, 6);
  });
});
