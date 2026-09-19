import { describe, expect, it } from 'vitest';
import { ObjectAnchorTracker } from './objectAnchor';
import { renderShelf } from './testing/renderShelf';
import { kallax } from '../data/kallax';
import type { Pose } from '../engine/types';

const W = 640;
const H = 480;
const frame = (left: number, top: number, span: number) =>
  renderShelf({ width: W, height: H, left, top, span });

const target = kallax.recognition!;
const make = () => new ObjectAnchorTracker(target, { detectIntervalMs: 400, fovDeg: 60 });

describe('object anchoring', () => {
  /**
   * Two frames used to be the price of a lock, and a device log showed what
   * that buys: two instrument cases standing on a real KALLAX read as a fourth
   * board line, and because the cases do not move, two consecutive detections
   * agreed on the wrong lattice and committed it at 0.94 confidence. A steady
   * misreading is not the one-frame fluke the two-frame rule was written for.
   */
  it('will not commit on two agreeing detections — a steady misreading has two', () => {
    const tracker = make();
    const shelf = frame(160, 60, 320);
    expect(tracker.update(shelf, 0), 'one frame must not be enough').toBeUndefined();
    expect(tracker.update(shelf, 200), 'and it should not re-detect too soon').toBeUndefined();
    expect(tracker.update(shelf, 500), 'two agreeing frames must not be enough').toBeUndefined();
    expect(tracker.hasLock, 'and no lock may be held on two').toBe(false);

    const locked = tracker.update(shelf, 1000);
    expect(locked?.mode, 'the third agreeing frame commits').toBe('detected');
    expect(tracker.hasLock).toBe(true);
  });

  it('starts the run again when a detection disagrees with the one before it', () => {
    const tracker = make();
    // Two frames of one reading, then one of a different one: the run resets to
    // the newcomer rather than committing on a count that spans both.
    tracker.update(frame(160, 60, 320), 0);
    tracker.update(frame(160, 60, 320), 500);
    expect(tracker.update(frame(40, 200, 180), 1000), 'a disagreeing frame cannot be the third').toBeUndefined();
    expect(tracker.hasLock).toBe(false);
  });

  /**
   * A real device log showed a session where recognition never once locked,
   * despite the shelf being genuinely detectable — because the acquisition
   * streak compared camera-space poses across frames from different camera
   * positions. An operator aiming a handheld phone moves the camera by more
   * than `AGREEMENT_M` between two detection intervals as a matter of
   * course; that read as "the object moved" every time, and three agreeing
   * frames never happened. Three different-looking screen reads here stand
   * in for a phone being panned between detections; a `cameraToWorld` mock
   * that puts them all at the same spot in the world is what the renderer's
   * real transform does when the shelf has not actually moved.
   */
  it('agrees across frames once camera motion between them is accounted for', () => {
    const tracker = make();
    const fixedWorld: Pose = { position: [0, 0, 2], rotation: [0, 0, 0, 1] };
    const toWorld = () => fixedWorld;
    expect(tracker.update(frame(160, 60, 320), 0, undefined, toWorld)).toBeUndefined();
    expect(tracker.update(frame(40, 200, 180), 500, undefined, toWorld)).toBeUndefined();
    const locked = tracker.update(frame(220, 20, 380), 1000, undefined, toWorld);
    expect(
      locked?.mode,
      'three genuinely different camera-space reads still commit once world space agrees',
    ).toBe('detected');
    expect(tracker.hasLock).toBe(true);
  });

  it('still rejects real disagreement when the camera has not moved', () => {
    // The counterpart to the test above: with the default identity
    // cameraToWorld (a stationary camera), genuinely different detections
    // must still fail to agree — the fix must not make every reading agree
    // regardless of the world-space transform.
    const tracker = make();
    tracker.update(frame(160, 60, 320), 0);
    tracker.update(frame(40, 200, 180), 500);
    expect(tracker.update(frame(220, 20, 380), 1000)).toBeUndefined();
    expect(tracker.hasLock).toBe(false);
  });

  it('then reports a pose on every frame, not once per detection interval', () => {
    const tracker = make();
    tracker.update(frame(160, 60, 320), 0);
    tracker.update(frame(160, 60, 320), 500);
    tracker.update(frame(160, 60, 320), 1000);
    expect(tracker.hasLock).toBe(true);

    // Frames arriving 33 ms apart — far inside the 400 ms detection interval.
    const ranges: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const obs = tracker.update(frame(160 - i * 3, 60 - i * 2, 320 + i * 6), 1000 + i * 33);
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
    tracker.update(frame(160, 60, 320), 1000);
    expect(tracker.hasLock).toBe(true);

    const blank = renderShelf({ width: W, height: H, left: -900, top: -900, span: 100 });
    tracker.update(blank, 1033);
    expect(tracker.hasLock).toBe(false);

    tracker.update(frame(170, 70, 320), 1500);
    tracker.update(frame(170, 70, 320), 2000);
    const back = tracker.update(frame(170, 70, 320), 2500);
    expect(back?.mode).toBe('detected');
    expect(tracker.hasLock).toBe(true);
  });

  it('measures the outline its lock implies against the image it is looking at', () => {
    const tracker = make();
    tracker.update(frame(160, 60, 320), 0);
    tracker.update(frame(160, 60, 320), 500);
    tracker.update(frame(160, 60, 320), 1000);
    expect(tracker.hasLock).toBe(true);

    const obs = tracker.update(frame(160, 60, 320), 1033)!;
    expect(obs.mode).toBe('tracked');
    expect(obs.agreement, 'the first tracked frame is due a measurement').toBeDefined();
    // The projection carries the target's full extent out to its corners
    // through the tracked points' own homography. Getting the model convention
    // wrong there would put the outline somewhere else entirely and this would
    // read near zero, which is the point of asserting it.
    expect(obs.agreement!.coverage, 'a correct lock finds its own edges').toBeGreaterThan(0.5);
    expect(Math.abs(obs.agreement!.medianOffsetPx!), 'and finds them where it says').toBeLessThan(10);
  });

  it('does not pay for that measurement on every frame', () => {
    const tracker = make();
    tracker.update(frame(160, 60, 320), 0);
    tracker.update(frame(160, 60, 320), 500);
    tracker.update(frame(160, 60, 320), 1000);
    expect(tracker.update(frame(160, 60, 320), 1033)!.agreement, 'due').toBeDefined();
    expect(tracker.update(frame(160, 60, 320), 1066)!.agreement, 'not due yet').toBeUndefined();
  });

  it('reports where the object is, at a plausible range and upright', () => {
    const tracker = make();
    tracker.update(frame(160, 60, 320), 0);
    tracker.update(frame(160, 60, 320), 500);
    const obs = tracker.update(frame(160, 60, 320), 1000)!;
    // A 1.44 m lattice filling half a 60-degree frame is about 1.9 m away.
    expect(obs.pose.position[2]).toBeGreaterThan(1.5);
    expect(obs.pose.position[2]).toBeLessThan(2.5);
    expect(obs.reprojectionPx).toBeLessThan(3);
    expect(obs.confidence).toBeGreaterThan(0.5);
  });
});
