import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchXrCamera, XR_CAMERA_WAIT_MS } from './xrCameraWatch';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const clock = () => Date.now();

describe('does this AR host give us its camera image?', () => {
  it('says available as soon as the first frame is there', () => {
    let frame = false;
    const onResult = vi.fn();
    watchXrCamera(() => frame, () => true, onResult, XR_CAMERA_WAIT_MS, clock);
    vi.advanceTimersByTime(1000);
    expect(onResult).not.toHaveBeenCalled();
    frame = true;
    vi.advanceTimersByTime(250);
    expect(onResult).toHaveBeenCalledWith('available', expect.any(Number));
  });

  it('says unavailable when no frame comes in time — the App Clip may not implement camera-access', () => {
    const onResult = vi.fn();
    watchXrCamera(() => false, () => true, onResult, XR_CAMERA_WAIT_MS, clock);
    vi.advanceTimersByTime(XR_CAMERA_WAIT_MS - 250);
    expect(onResult, 'not before the wait is up').not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0]).toBe('unavailable');
  });

  it('does not wait longer than a slow Android first frame needs, and not less', () => {
    // Measured: 1.5 s to the first frame on a real device. The wait must be
    // comfortably longer, and a frame at 3 s still counts.
    expect(XR_CAMERA_WAIT_MS).toBeGreaterThanOrEqual(3 * 1500);
    let frame = false;
    const onResult = vi.fn();
    watchXrCamera(() => frame, () => true, onResult, XR_CAMERA_WAIT_MS, clock);
    vi.advanceTimersByTime(3000);
    frame = true;
    vi.advanceTimersByTime(250);
    expect(onResult).toHaveBeenCalledWith('available', expect.any(Number));
  });

  it('stops quietly when the session ends first', () => {
    let running = true;
    const onResult = vi.fn();
    watchXrCamera(() => false, () => running, onResult, XR_CAMERA_WAIT_MS, clock);
    vi.advanceTimersByTime(1000);
    running = false;
    vi.advanceTimersByTime(XR_CAMERA_WAIT_MS * 2);
    expect(onResult).not.toHaveBeenCalled();
  });
});
