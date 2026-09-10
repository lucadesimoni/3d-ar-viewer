/**
 * A frame, with what the app believed was in it.
 *
 * This is the data that makes part and change detection possible to build
 * rather than guess at: the camera's picture of the real assembly, and — from
 * the same instant — where the app expected every part to be on screen. One is
 * useless without the other. A picture alone cannot say whether a bolt is
 * missing; a picture with "the app thinks the bolt's head is at 0.42, 0.61"
 * can.
 *
 * It is also the honest answer to "how can I help you": press this on the real
 * bench, send the file, and detection can be developed against what the parts
 * actually look like under that light rather than against my imagination.
 */
import { addCapture, type Capture } from './report';
import { logEvent } from './log';
import type { SceneManager } from '../render/babylon/SceneManager';
import { useStore } from '../state/store';

/** Wide enough to see a fastener, small enough to send from a phone. */
const CAPTURE_WIDTH = 960;
const JPEG_QUALITY = 0.72;

export type CaptureResult =
  | { ok: true; capture: Capture }
  | { ok: false; reason: string };

/**
 * In a WebXR session there is no camera image to read.
 *
 * The compositor owns the picture and the page never sees it, unless the
 * session was granted the raw camera-access feature — which this app does not
 * ask for yet. So a capture there would be geometry with a black rectangle
 * attached, and saying so beats saving that.
 */
export function captureFrame(
  video: HTMLVideoElement | null,
  manager: SceneManager | undefined,
  note?: string,
): CaptureResult {
  if (!manager) return { ok: false, reason: 'The 3D view is not running.' };
  if (!video || video.readyState < 2 || !video.videoWidth) {
    return {
      ok: false,
      reason: 'No camera image to capture. In a WebXR session the picture belongs to the'
        + ' compositor and the page cannot read it; capture from camera passthrough instead.',
    };
  }
  const scale = Math.min(1, CAPTURE_WIDTH / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, reason: 'This browser refused a 2D canvas.' };
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const state = useStore.getState();
  const view = manager.cameraPose();
  const capture: Capture = {
    at: Date.now(),
    image: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
    camera: view,
    parts: state.assembly.parts.map((part) => {
      const p = manager.projectPart(part.id);
      // An unplaced assembly projects to nothing, and the maths comes back
      // NaN — which JSON writes as `null`. A file promising numbers and
      // delivering nulls is a trap for whoever reads it later, and the whole
      // point of this file is that someone reads it later.
      const at = (v: number | undefined): number => (
        typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(4)) : -1
      );
      // And the region the geometry says this part occupies, in the pixels of
      // the image actually attached. A frame that carries its own expectation
      // is a frame someone can check later — or train against.
      const roi = manager.roiForPart(part.id, { width: canvas.width, height: canvas.height });
      return {
        id: part.id,
        name: part.name,
        x: at(p?.x),
        y: at(p?.y),
        onScreen: Boolean(p?.onScreen) && Number.isFinite(p?.x) && Number.isFinite(p?.y),
        ...(roi ? {
          roi: [
            Math.round(roi.rect.x), Math.round(roi.rect.y),
            Math.round(roi.rect.w), Math.round(roi.rect.h),
          ] as [number, number, number, number],
          roiClipped: roi.clipped,
        } : {}),
      };
    }),
    ...(note ? { note } : {}),
  };
  addCapture(capture);
  logEvent('capture', 'frame captured', {
    size: [canvas.width, canvas.height],
    partsOnScreen: capture.parts.filter((p) => p.onScreen).length,
  });
  return { ok: true, capture };
}
