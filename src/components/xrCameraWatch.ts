/**
 * Whether the AR host hands this page its camera image.
 *
 * On Android, Chrome grants WebXR `camera-access` and the first frame arrived
 * about 1.5 s into the session in a real device log. On iPhone and iPad the
 * page runs inside an App Clip that provides WebXR over ARKit, and whether that
 * host implements `camera-access` at all is not something this code can know
 * in advance. Without an image there is no recognition and no presence check,
 * so the app has to stop inviting the operator to "point it at the shelf".
 *
 * Polls rather than subscribes: the camera texture is set inside the XR frame
 * by the renderer, and a quarter-second answer is plenty for a hint.
 */
export type XrCameraImage = 'unknown' | 'available' | 'unavailable';

/** Several times Android's measured 1.5 s, so a slow first frame is not called missing. */
export const XR_CAMERA_WAIT_MS = 5000;

export function watchXrCamera(
  hasFrame: () => boolean,
  stillRunning: () => boolean,
  onResult: (result: Exclude<XrCameraImage, 'unknown'>, waitedMs: number) => void,
  waitMs = XR_CAMERA_WAIT_MS,
  now: () => number = () => performance.now(),
): () => void {
  const started = now();
  const timer = setInterval(() => {
    if (!stillRunning()) { clearInterval(timer); return; }
    const waited = now() - started;
    if (hasFrame()) { clearInterval(timer); onResult('available', waited); return; }
    if (waited >= waitMs) { clearInterval(timer); onResult('unavailable', waited); }
  }, 250);
  return () => clearInterval(timer);
}
