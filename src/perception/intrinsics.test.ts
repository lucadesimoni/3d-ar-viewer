import { describe, expect, it } from 'vitest';
import {
  ASSUMED_FOV_DEG,
  cameraIntrinsics,
  fovFromRaw,
  isMeasured,
} from './intrinsics';

/** Exactly what a real Android device reported through `camera-access`. */
const RAW = { ax: 1316.8172211647034, ay: 1317.0457077026367, u0: 443, v0: 960, width: 886, height: 1920 };

describe('how well the camera geometry is known', () => {
  it('reads the field of view the platform actually reported', () => {
    // 2·atan(960/1317) = 72.2°, and Babylon's reading of the XR projection
    // matrix said 72.18 independently. The app had been assuming 60.
    expect(fovFromRaw(RAW)).toBeCloseTo(72.2, 1);
  });

  it('prefers the platform\'s own intrinsics to everything else', () => {
    const k = cameraIntrinsics({
      frame: { width: 886, height: 1920 }, raw: RAW, xrFovDeg: 72.18, operatorFovDeg: 65,
    });
    expect(k.source).toBe('xr-raw');
    expect(k.fx).toBeCloseTo(1316.82, 2);
    expect(k.cy).toBeCloseTo(960, 6);
    expect(k.fovDeg).toBeCloseTo(72.2, 1);
  });

  it('scales those intrinsics to the frame they are asked about', () => {
    // The XR image was 886×1920; the passthrough video on the same phone is
    // 1080×1920. Same rows, a wider strip of them.
    const k = cameraIntrinsics({ frame: { width: 1080, height: 1920 }, raw: RAW });
    expect(k.fy).toBeCloseTo(RAW.ay, 6);
    expect(k.cy).toBeCloseTo(960, 6);
    expect(k.cx).toBeCloseTo(540, 0);
    expect(k.fovDeg).toBeCloseTo(72.2, 1);

    // Half the resolution is the same camera: the same angle, half the focal.
    const half = cameraIntrinsics({ frame: { width: 443, height: 960 }, raw: RAW });
    expect(half.fy).toBeCloseTo(RAW.ay / 2, 6);
    expect(half.fovDeg).toBeCloseTo(k.fovDeg, 6);
  });

  it('falls back to the XR projection when no image was granted', () => {
    const k = cameraIntrinsics({ frame: { width: 1080, height: 1920 }, xrFovDeg: 72.18, operatorFovDeg: 65 });
    expect(k.source).toBe('xr-camera');
    expect(k.fovDeg).toBeCloseTo(72.18, 6);
    // A measurement outranks a hand-set number: the slider is somebody's guess.
    // (A wider view means a *shorter* focal length, so compare the angle.)
    expect(cameraIntrinsics({ frame: { width: 1080, height: 1920 }, operatorFovDeg: 65 }).fovDeg)
      .toBeCloseTo(65, 6);
  });

  it('takes the operator setting only when it has been moved', () => {
    const frame = { width: 1080, height: 1920 };
    expect(cameraIntrinsics({ frame, operatorFovDeg: 65 }).source).toBe('operator');
    // Left at the default, it is the assumption wearing the operator's name.
    expect(cameraIntrinsics({ frame, operatorFovDeg: ASSUMED_FOV_DEG }).source).toBe('assumed');
    expect(cameraIntrinsics({ frame }).source).toBe('assumed');
    expect(cameraIntrinsics({ frame }).fovDeg).toBe(ASSUMED_FOV_DEG);
  });

  it('ignores nonsense rather than dividing by it', () => {
    const frame = { width: 1080, height: 1920 };
    expect(cameraIntrinsics({ frame, xrFovDeg: 0 }).source).toBe('assumed');
    expect(cameraIntrinsics({ frame, xrFovDeg: 180 }).source).toBe('assumed');
    expect(cameraIntrinsics({ frame, raw: { ...RAW, ay: 0 } }).source).toBe('assumed');
    // A zero-sized frame would otherwise produce an infinite focal length.
    const empty = cameraIntrinsics({ frame: { width: 0, height: 0 }, raw: RAW });
    expect(Number.isFinite(empty.fx) && Number.isFinite(empty.fy)).toBe(true);
  });

  it('says which of its answers are measurements', () => {
    expect(isMeasured('xr-raw')).toBe(true);
    expect(isMeasured('xr-camera')).toBe(true);
    expect(isMeasured('operator')).toBe(false);
    expect(isMeasured('assumed')).toBe(false);
  });

  it('round-trips a field of view through the focal length it implies', () => {
    for (const deg of [45, 60, 72.18, 90, 110]) {
      const k = cameraIntrinsics({ frame: { width: 640, height: 480 }, xrFovDeg: deg });
      expect(k.fovDeg).toBeCloseTo(deg, 6);
    }
  });
});
