import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { angleBetweenDeg, orientationToQuaternion, smoothingFactor } from './cameraTracker';

/**
 * What the device's attitude has to mean, stated as physics rather than as
 * whatever the code happens to compute.
 *
 * The bug these exist for: `alpha` (compass heading) and `gamma` (device roll)
 * were fed to the wrong axes of the Euler triple. At `beta = 90` — a phone held
 * bolt upright — the YXZ order is in gimbal lock and the two are
 * interchangeable, so every hand-written check passed. Away from upright the
 * *pitch* of the virtual camera followed the compass: point the phone at the
 * floor and turn on the spot, and the view swung from 30 degrees down, through
 * level, to 30 degrees *up*. The overlay was then permanently off screen, in a
 * direction that changed as the operator turned to look for it.
 *
 * Every assertion below is about the camera's forward and up vectors, which is
 * what the renderer consumes — not about the quaternion's components, which can
 * be right in several equivalent ways.
 */

const DEG = Math.PI / 180;
/** Where the camera points, in the renderer's frame (three/WebXR: down -Z). */
const forward = (a: number, b: number, g: number, screen = 0): Vector3 =>
  new Vector3(0, 0, -1).applyQuaternion(orientationToQuaternion(a, b, g, screen) as unknown as Quaternion);
/** Which way is up on screen — the horizon's tilt. */
const up = (a: number, b: number, g: number, screen = 0): Vector3 =>
  new Vector3(0, 1, 0).applyQuaternion(orientationToQuaternion(a, b, g, screen) as unknown as Quaternion);

/** Degrees above (+) or below (−) the horizon that the camera is pointing. */
const pitchDeg = (v: Vector3): number => Math.asin(Math.max(-1, Math.min(1, v.y))) / DEG;
/** Compass-plane direction of view, degrees, for comparing two headings. */
const yawDeg = (v: Vector3): number => Math.atan2(v.x, v.z) / DEG;

const HEADINGS = [0, 45, 90, 137, 180, 217, 270, 359];

describe('device orientation → camera', () => {
  it('holds pitch while the operator turns on the spot', () => {
    // beta = 90 is upright; 60 is the top of the phone tipped 30° away, which
    // is what looking at the floor two metres ahead actually looks like.
    for (const alpha of HEADINGS) {
      expect(pitchDeg(forward(alpha, 60, 0)), `heading ${alpha}°`).toBeCloseTo(-30, 1);
      expect(pitchDeg(forward(alpha, 120, 0)), `heading ${alpha}°`).toBeCloseTo(30, 1);
      expect(pitchDeg(forward(alpha, 90, 0)), `heading ${alpha}°`).toBeCloseTo(0, 1);
    }
  });

  it('keeps the horizon level while the operator turns', () => {
    for (const alpha of HEADINGS) {
      // With no device roll the screen's up must stay in the vertical plane:
      // the horizon may recede with pitch, but it must never tilt.
      expect(up(alpha, 60, 0).y, `heading ${alpha}°`).toBeGreaterThan(0.8);
    }
  });

  it('turns the view by exactly as much as the operator turned', () => {
    const base = yawDeg(forward(0, 60, 0));
    for (const turn of [30, 90, 180, 270]) {
      const turned = yawDeg(forward(turn, 60, 0));
      const delta = ((turned - base + 540) % 360) - 180;
      expect(Math.abs(delta), `turning ${turn}°`).toBeCloseTo(turn > 180 ? 360 - turn : turn, 0);
    }
  });

  it('treats gamma as a turn, not a tilt, while the phone is upright', () => {
    // gamma is rotation about the screen's own vertical axis. With the phone
    // held upright that axis *is* the world's vertical, so tipping it left or
    // right turns the view and must not roll the horizon.
    expect(yawDeg(forward(0, 90, 30))).not.toBeCloseTo(yawDeg(forward(0, 90, 0)), 0);
    expect(up(0, 90, 30).y).toBeCloseTo(1, 2);
  });

  it('keeps the horizon level for a tablet held in landscape', () => {
    // Landscape is beta ≈ 0 with gamma ≈ ∓90, and the browser reports the
    // matching screen angle; the compensation has to cancel it exactly or the
    // whole scene renders on its side on every tablet.
    for (const [gamma, screen] of [[-90, 90], [90, 270]]) {
      const level = forward(0, 0, gamma, screen);
      expect(Math.abs(level.y), `gamma ${gamma}°`).toBeLessThan(0.02);
      expect(up(0, 0, gamma, screen).y, `gamma ${gamma}°`).toBeCloseTo(1, 2);
    }
  });

  it('pitches down as the phone is tipped down, at every heading', () => {
    for (const alpha of [0, 137, 300]) {
      const level = pitchDeg(forward(alpha, 90, 0));
      const tipped = pitchDeg(forward(alpha, 55, 0));
      expect(tipped, `heading ${alpha}°`).toBeLessThan(level - 30);
    }
  });
});

/**
 * The filter between the sensor and the scene.
 *
 * A phone's magnetometer indoors is not a smooth signal: it sits still, then
 * jumps ten or twenty degrees as it passes a steel upright, then comes back.
 * Following that faithfully is what made the overlay "hop around". Damping it
 * enough to sit still, while still following a deliberate turn within a tenth
 * of a second, is the whole job.
 */
describe('orientation filtering', () => {
  it('damps hand tremor hard and deliberate movement lightly', () => {
    expect(smoothingFactor(0.2)).toBeLessThan(0.1);     // tremor: almost ignored
    expect(smoothingFactor(20)).toBeGreaterThan(0.2);   // a turn: followed
    expect(smoothingFactor(20)).toBeLessThanOrEqual(0.25);
  });

  it('never follows instantly, however large the step', () => {
    // An unclamped factor would make a single noisy reading the new truth.
    for (const step of [50, 180, 1000]) {
      expect(smoothingFactor(step), `${step}°`).toBeLessThanOrEqual(0.25);
    }
  });

  it('measures the angle between two orientations', () => {
    const level = orientationToQuaternion(0, 90, 0);
    expect(angleBetweenDeg(level, level)).toBeCloseTo(0, 5);
    // Thirty degrees of heading is thirty degrees of rotation.
    expect(angleBetweenDeg(level, orientationToQuaternion(30, 90, 0))).toBeCloseTo(30, 0);
    expect(angleBetweenDeg(level, orientationToQuaternion(0, 60, 0))).toBeCloseTo(30, 0);
  });
});
