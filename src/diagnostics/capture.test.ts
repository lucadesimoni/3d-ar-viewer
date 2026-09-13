import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFrame } from './capture';
import { clearCaptures, capturedFrames } from './report';
import { clearLog, logEntries } from './log';
import type { SceneManager } from '../render/babylon/SceneManager';

/**
 * A manager that answers the four questions a capture asks, and says which
 * mode it is in — the one thing that used to decide whether it refused.
 */
function fakeManager(frameSource: 'video' | 'xr-raw' | 'xr-blind') {
  return {
    renderStats: () => ({ frameSource }),
    xrCameraFrame: vi.fn(async () => new ImageData(new Uint8ClampedArray(4 * 8 * 8).fill(180), 8, 8)),
    cameraFrameCost: () => ({ readbackMs: 12.3, scaleMs: 1.4, sourceSize: [886, 1920] as [number, number] }),
    cameraPose: () => ({ position: [0, 1, 0], rotation: [0, 0, 0, 1], fovDeg: 72.18 }),
    projectPart: () => ({ x: 0.5, y: 0.5, onScreen: true }),
    roiForPart: () => ({ rect: { x: 1, y: 2, w: 3, h: 4 }, areaFraction: 0.1, distanceM: 1, clipped: false }),
  } as unknown as SceneManager;
}

/**
 * jsdom has no 2D context and no JPEG encoder. Neither is what these tests are
 * about — which source the picture comes from, and what the file says about it
 * — so the drawing surface is stubbed and the pixels are nobody's business.
 */
beforeEach(() => {
  clearCaptures();
  clearLog();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(), putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValue('data:image/jpeg;base64,/9j/stub');
});

afterEach(() => vi.restoreAllMocks());

describe('capturing the frame that matters', () => {
  it('captures inside a session, which it used to refuse outright', async () => {
    // The refusal outlived its reason. Its own comment said the app "does not
    // ask for" raw camera access — it does now, Android grants it, and a
    // device log shows `frameSource: xr-raw`. And a session is the mode worth
    // capturing from: a capture is the picture *plus* where the app believed
    // every part was, and that half is only as good as the anchor behind it.
    const manager = fakeManager('xr-raw');
    const result = await captureFrame(null, manager);
    expect(result.ok).toBe(true);
    expect(manager.xrCameraFrame).toHaveBeenCalled();
    const capture = capturedFrames()[0];
    expect(capture.image.startsWith('data:image/')).toBe(true);
    expect(capture.parts[0]).toMatchObject({ onScreen: true, roi: [1, 2, 3, 4] });
  });

  it('carries what the readback cost, which is the open question about it', async () => {
    await captureFrame(null, fakeManager('xr-raw'));
    const entry = logEntries().find((e) => e.message === 'frame captured');
    expect(entry?.data).toMatchObject({ source: 'xr-raw', readbackMs: 12.3, scaleMs: 1.4 });
  });

  it('says plainly when the session is the one that will not hand a camera over', async () => {
    // The iPad clip. A refusal is right here — but for the true reason, not
    // for a blanket "sessions cannot read the camera".
    const manager = fakeManager('xr-blind');
    const result = await captureFrame(null, manager);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.reason).toContain('did not grant camera access');
    expect(manager.xrCameraFrame).not.toHaveBeenCalled();
    expect(capturedFrames()).toHaveLength(0);
  });

  it('still reads the video on the passthrough path', async () => {
    const manager = fakeManager('video');
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { value: 4 });
    Object.defineProperty(video, 'videoWidth', { value: 640 });
    Object.defineProperty(video, 'videoHeight', { value: 480 });
    const result = await captureFrame(video, manager);
    expect(result.ok).toBe(true);
    expect(manager.xrCameraFrame).not.toHaveBeenCalled();
  });

  it('refuses rather than attaching a blank rectangle when there is no picture', async () => {
    expect(await captureFrame(null, fakeManager('video'))).toMatchObject({ ok: false });
    expect(await captureFrame(null, undefined)).toMatchObject({ ok: false });
    expect(capturedFrames()).toHaveLength(0);
  });
});
