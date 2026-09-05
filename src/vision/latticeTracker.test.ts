import { describe, expect, it } from 'vitest';
import { LatticeTracker } from './latticeTracker';
import { detectGridFacade } from './gridRecognition';
import { renderShelf } from './testing/renderShelf';
import {
  estimateIntrinsics,
  planePoseFromPoints,
  solveHomography,
} from '../engine/tracking/markerTracking';
import { KALLAX_DIMENSIONS } from '../data/kallax';

const W = 640;
const H = 480;
const LATTICE_M = KALLAX_DIMENSIONS.widthM - KALLAX_DIMENSIONS.boardT;
const TARGET = { cols: 4, rows: 4, widthM: LATTICE_M, heightM: LATTICE_M };
const K = estimateIntrinsics(W, H, 60);

const frame = (left: number, top: number, span: number, extra = {}) =>
  renderShelf({ width: W, height: H, left, top, span, ...extra });

function seeded(left = 160, top = 60, span = 320) {
  const first = frame(left, top, span);
  const obs = detectGridFacade(first)!;
  const tracker = new LatticeTracker(solveHomography);
  expect(tracker.seed(first, obs, TARGET)).toBe(true);
  return { tracker, obs };
}

/** Range implied by a tracked frame, metres. */
function rangeOf(tracker: LatticeTracker, image: ImageData): number | undefined {
  const t = tracker.track(image);
  if (!t) return undefined;
  const solved = planePoseFromPoints(t.model, t.image, K);
  return solved ? solved.pose.position[2] : undefined;
}

describe('lattice tracking', () => {
  it('follows the object as it moves across the frame', () => {
    const { tracker } = seeded();
    let last: number[] = [];
    for (let step = 1; step <= 8; step++) {
      const t = tracker.track(frame(160 + step * 6, 60 + step * 3, 320));
      expect(t, `lost the object at step ${step}`).toBeDefined();
      expect(t!.confidence).toBeGreaterThan(0.6);
      const centreX = t!.image.reduce((a, p) => a + p.x, 0) / t!.image.length;
      last = [...last, centreX];
    }
    // The tracked points must move with the object, ~6 px per step.
    const drift = (last[last.length - 1] - last[0]) / (last.length - 1);
    expect(drift).toBeGreaterThan(4.5);
    expect(drift).toBeLessThan(7.5);
  });

  it('reports the object getting closer as a shorter range', () => {
    const { tracker } = seeded(160, 60, 300);
    const near = rangeOf(tracker, frame(150, 50, 320));
    const nearer = rangeOf(tracker, frame(130, 30, 360));
    expect(near).toBeDefined();
    expect(nearer).toBeDefined();
    // Apparent size up 12.5% means range down by the same factor.
    expect(nearer! / near!).toBeCloseTo(320 / 360, 1);
  });

  it('holds the lock when the camera re-exposes', () => {
    const { tracker } = seeded();
    const t = tracker.track(frame(166, 63, 320, { exposure: 1.25, noise: 12 }));
    expect(t).toBeDefined();
    expect(t!.confidence).toBeGreaterThan(0.6);
  });

  it('does not drift over a long run of small moves', () => {
    const { tracker } = seeded(160, 60, 320);
    let t;
    for (let step = 1; step <= 30; step++) t = tracker.track(frame(160 + step, 60, 320));
    expect(t).toBeDefined();
    // After 30 steps of 1 px the lattice must still sit on the real lattice:
    // compare the tracked points against a fresh detection of the same frame.
    const truth = detectGridFacade(frame(190, 60, 320))!;
    const trackedLeft = Math.min(...t!.image.map((p) => p.x));
    expect(Math.abs(trackedLeft - truth.xLines[0])).toBeLessThan(3);
  });

  it('states its motion budget: fast pans survive, a whip pan drops the lock', () => {
    // Roughly 25 px of image motion per frame is covered by the coarse pass,
    // and twice that by the widened retry. Beyond it the honest answer is to
    // let go and re-detect rather than to match something that looks similar.
    const fast = seeded(160, 60, 320);
    expect(fast.tracker.track(frame(185, 60, 320))).toBeDefined();

    const whip = seeded(160, 60, 320);
    expect(whip.tracker.track(frame(160 + 120, 60, 320))).toBeUndefined();
    expect(whip.tracker.tracking).toBe(false);
  });

  it('lets go rather than reporting a pose for something else', () => {
    const { tracker } = seeded();
    const noise = new ImageData(
      Uint8ClampedArray.from({ length: W * H * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 7919) % 255)),
      W, H,
    );
    expect(tracker.track(noise)).toBeUndefined();
    expect(tracker.tracking).toBe(false);
  });

  it('recovers when a frame is dropped and everything moves twice as far', () => {
    const { tracker } = seeded(160, 60, 320);
    // 30 px at this working size is beyond the per-frame search window; the
    // widened second pass is what has to catch it.
    const t = tracker.track(frame(190, 80, 320));
    expect(t).toBeDefined();
    expect(t!.confidence).toBeGreaterThan(0.6);
  });

  it('agrees with a fresh detection of the same frame', () => {
    const { tracker } = seeded(160, 60, 320);
    const moved = frame(176, 72, 330);
    const tracked = tracker.track(moved)!;
    const trackedPose = planePoseFromPoints(tracked.model, tracked.image, K)!.pose;

    const obs = detectGridFacade(moved)!;
    const fresh = new LatticeTracker(solveHomography);
    fresh.seed(moved, obs, TARGET);
    const freshTracked = fresh.track(moved)!;
    const freshPose = planePoseFromPoints(freshTracked.model, freshTracked.image, K)!.pose;

    for (let i = 0; i < 3; i++) {
      expect(Math.abs(trackedPose.position[i] - freshPose.position[i])).toBeLessThan(0.05);
    }
  });
});
