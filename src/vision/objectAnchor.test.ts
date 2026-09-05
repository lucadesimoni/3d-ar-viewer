import { describe, expect, it } from 'vitest';
import { ObjectAnchorTracker } from './objectAnchor';
import { renderShelf } from './testing/renderShelf';
import { kallax } from '../data/kallax';

const W = 640;
const H = 480;
const frame = (left: number, top: number, span: number) =>
  renderShelf({ width: W, height: H, left, top, span });

const target = kallax.recognition!;
const make = () => new ObjectAnchorTracker(target, { detectIntervalMs: 400, fovDeg: 60 });

describe('object anchoring', () => {
  it('needs two agreeing detections before it commits', () => {
    const tracker = make();
    const shelf = frame(160, 60, 320);
    expect(tracker.update(shelf, 0), 'one frame must not be enough').toBeUndefined();
    expect(tracker.update(shelf, 200), 'and it should not re-detect too soon').toBeUndefined();

    const locked = tracker.update(shelf, 500);
    expect(locked?.mode).toBe('detected');
    expect(tracker.hasLock).toBe(true);
  });

  it('then reports a pose on every frame, not once per detection interval', () => {
    const tracker = make();
    tracker.update(frame(160, 60, 320), 0);
    tracker.update(frame(160, 60, 320), 500);
    expect(tracker.hasLock).toBe(true);

    // Frames arriving 33 ms apart — far inside the 400 ms detection interval.
    const ranges: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const obs = tracker.update(frame(160 - i * 3, 60 - i * 2, 320 + i * 6), 500 + i * 33);
      expect(obs, `no pose on frame ${i}`).toBeDefined();
      expect(obs!.mode).toBe('tracked');
      ranges.push(obs!.pose.position[2]);
    }
    // Walking towards the shelf: every frame must report it a little closer.
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]).toBeLessThan(ranges[i - 1]);
    expect(ranges[ranges.length - 1]).toBeLessThan(ranges[0] * 0.9);
  });

  it('drops the lock when the object goes away, and re-acquires when it returns', () => {
    const tracker = make();
    tracker.update(frame(160, 60, 320), 0);
    tracker.update(frame(160, 60, 320), 500);
    expect(tracker.hasLock).toBe(true);

    const blank = renderShelf({ width: W, height: H, left: -900, top: -900, span: 100 });
    tracker.update(blank, 533);
    expect(tracker.hasLock).toBe(false);

    tracker.update(frame(170, 70, 320), 1000);
    const back = tracker.update(frame(170, 70, 320), 1500);
    expect(back?.mode).toBe('detected');
    expect(tracker.hasLock).toBe(true);
  });

  it('reports where the object is, at a plausible range and upright', () => {
    const tracker = make();
    tracker.update(frame(160, 60, 320), 0);
    const obs = tracker.update(frame(160, 60, 320), 500)!;
    // A 1.44 m lattice filling half a 60-degree frame is about 1.9 m away.
    expect(obs.pose.position[2]).toBeGreaterThan(1.5);
    expect(obs.pose.position[2]).toBeLessThan(2.5);
    expect(obs.reprojectionPx).toBeLessThan(3);
    expect(obs.confidence).toBeGreaterThan(0.5);
  });
});
