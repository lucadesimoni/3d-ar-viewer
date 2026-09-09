import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkerTracker, estimateIntrinsics } from './markerTracking';

/** A square QR, seen straight on, filling a fifth of a 1080×1920 frame. */
const CORNERS = [
  { x: 440, y: 860 }, { x: 640, y: 860 }, { x: 640, y: 1060 }, { x: 440, y: 1060 },
];

function stubDetector(): void {
  vi.stubGlobal('BarcodeDetector', class {
    async detect(): Promise<unknown[]> {
      return [{ rawValue: 'bench-1', cornerPoints: CORNERS }];
    }
  });
}

const video = { videoWidth: 1080, videoHeight: 1920, readyState: 2 } as HTMLVideoElement;

/** Drive one scan directly; the interval is the app's business, not this test's. */
const scanOnce = (t: MarkerTracker): Promise<void> =>
  (t as unknown as { scan: (v: HTMLVideoElement) => Promise<void> }).scan(video);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('what the marker tracker measures the camera with', () => {
  it('asks for the calibration each frame, for the frame it is reading', async () => {
    stubDetector();
    const calibration = vi.fn((width: number, height: number) => estimateIntrinsics(width, height, 72.18));
    const tracker = new MarkerTracker(0.1, vi.fn(), calibration);
    await scanOnce(tracker);
    await scanOnce(tracker);
    // Per frame, not once at construction: a calibration that arrives mid
    // session — the platform granting camera-access — must be picked up.
    expect(calibration).toHaveBeenCalledTimes(2);
    expect(calibration).toHaveBeenCalledWith(1080, 1920);
  });

  it('puts the marker at a different range for a different field of view', async () => {
    stubDetector();
    const at = async (fovDeg: number): Promise<number> => {
      const seen = vi.fn();
      await scanOnce(new MarkerTracker(0.1, seen, (w, h) => estimateIntrinsics(w, h, fovDeg)));
      return seen.mock.calls[0][0].pose.position[2];
    };
    const assumed = await at(60);
    const measured = await at(72.18);
    // A wider real view means a shorter focal length, and the same marker in
    // the same pixels is nearer than the assumption said. On the device that
    // reported 72.2 where the app assumed 60, that is a fifth of the range.
    expect(measured).toBeLessThan(assumed);
    expect(Math.abs(measured / assumed - 1)).toBeGreaterThan(0.15);
  });

  it('falls back to the stated assumption when nobody supplies one', async () => {
    stubDetector();
    const seen = vi.fn();
    await scanOnce(new MarkerTracker(0.1, seen));
    const withAssumption = vi.fn();
    await scanOnce(new MarkerTracker(0.1, withAssumption, (w, h) => estimateIntrinsics(w, h, 60)));
    expect(seen.mock.calls[0][0].pose.position[2])
      .toBeCloseTo(withAssumption.mock.calls[0][0].pose.position[2], 9);
  });
});
