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
  | { ok: true; capture: Capture; onScreen: number; parts: number }
  | { ok: false; reason: string };

/**
 * The picture, from whichever mode is running.
 *
 * This used to refuse inside a WebXR session, and said why: the compositor
 * owns the picture, "unless the session was granted the raw camera-access
 * feature — which this app does not ask for yet". It does ask now, Android
 * grants it, and a device log shows `frameSource: xr-raw` with the real
 * intrinsics behind it. The refusal had outlived its reason.
 *
 * Which matters more than it sounds, because of what a capture is *for*: the
 * picture together with where the app believed every part was. That second
 * half is only as good as the anchor it was projected through — and the anchor
 * is at its best in a session and at its weakest in camera passthrough. The
 * one mode worth capturing from was the one mode that refused.
 *
 * One approximation comes with it, and is stated rather than hidden: the ROIs
 * are projected through the *renderer's* view, while the image comes from the
 * physical camera, which sits a little to one side of it. On a phone with a
 * single rear lens the two are close. How close is a question these captures
 * are exactly the data to answer.
 */
export async function captureFrame(
  video: HTMLVideoElement | null,
  manager: SceneManager | undefined,
  note?: string,
): Promise<CaptureResult> {
  if (!manager) return { ok: false, reason: 'The 3D view is not running.' };
  // Which mode is running decides where the picture comes from, and a mode
  // that has none is refused before anything is allocated for it.
  const source = manager.renderStats().frameSource;
  if (source === 'xr-blind') {
    return {
      ok: false,
      reason: 'This session did not grant camera access, so the picture belongs to the'
        + ' compositor and the page cannot read it. Capture from camera passthrough instead.',
    };
  }
  if (source === 'video' && (!video || video.readyState < 2 || !video.videoWidth)) {
    return { ok: false, reason: 'No camera image to capture — the camera is not running.' };
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, reason: 'This browser refused a 2D canvas.' };

  if (source === 'xr-raw') {
    const image = await manager.xrCameraFrame(CAPTURE_WIDTH);
    if (!image) {
      return { ok: false, reason: 'The session held a camera a moment ago and would not hand over a frame.' };
    }
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.putImageData(image, 0, 0);
  } else {
    const scale = Math.min(1, CAPTURE_WIDTH / video!.videoWidth);
    canvas.width = Math.round(video!.videoWidth * scale);
    canvas.height = Math.round(video!.videoHeight * scale);
    ctx.drawImage(video!, 0, 0, canvas.width, canvas.height);
  }

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
  const onScreen = capture.parts.filter((p) => p.onScreen).length;
  const cost = manager.cameraFrameCost();
  logEvent('capture', 'frame captured', {
    size: [canvas.width, canvas.height],
    source,
    partsOnScreen: onScreen,
    // What it cost to get the picture out of the session, which is the open
    // question about reading the camera in one at all.
    ...(source === 'xr-raw' && cost ? {
      readbackMs: Number(cost.readbackMs.toFixed(1)),
      scaleMs: Number(cost.scaleMs.toFixed(1)),
    } : {}),
  });
  return { ok: true, capture, onScreen, parts: capture.parts.length };
}
