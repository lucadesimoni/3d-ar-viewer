/**
 * What the camera's geometry actually is, and how well we know it.
 *
 * Turning a pixel into a ray needs a focal length. This app has assumed one —
 * 60 degrees vertical — since before there was anything to check it against,
 * and a five-degree error is roughly a ten per cent range error. On the first
 * device to report the truth the assumption was out by twelve: the platform
 * handed over `ax 1316.8, ay 1317.0, u0 443, v0 960` for an 886×1920 image,
 * which is 2·atan(960/1317) = 72.2 degrees, and Babylon's own reading of the
 * XR projection matrix agreed to two decimals. Two independent measurements,
 * one number, and twenty per cent away from what the app believed.
 *
 * So a measured focal length and a guessed one must never look alike. Every
 * result here says where it came from, and the ranking is fixed:
 *
 * 1. `xr-raw`    — full pinhole intrinsics from `camera-access`.
 * 2. `xr-camera` — the vertical field of view from the XR view's projection.
 * 3. `operator`  — the AR settings slider, when it has been moved.
 * 4. `assumed`   — 60 degrees, and said so.
 */

export type IntrinsicsSource = 'xr-raw' | 'xr-camera' | 'operator' | 'assumed';

/** The pinhole model, in the pixels of the frame it applies to. */
export interface CameraIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Vertical field of view implied by `fy` and `height`, in degrees. */
  fovDeg: number;
  source: IntrinsicsSource;
}

/** What the platform hands over when `camera-access` is granted. */
export interface RawIntrinsics {
  ax: number;
  ay: number;
  u0: number;
  v0: number;
  width: number;
  height: number;
}

export interface IntrinsicsInputs {
  /** The frame the intrinsics are wanted for — the video, or the XR image. */
  frame: { width: number; height: number };
  raw?: RawIntrinsics;
  /** Measured from the XR view's projection matrix, this session or an earlier one. */
  xrFovDeg?: number;
  /** The operator's setting. Equal to the assumption means untouched. */
  operatorFovDeg?: number;
}

/** The assumption, kept in one place so it can be recognised as one. */
export const ASSUMED_FOV_DEG = 60;

const degOf = (f: number, height: number): number => (2 * Math.atan(height / 2 / f) * 180) / Math.PI;
const focalOf = (fovDeg: number, height: number): number => height / 2 / Math.tan((fovDeg * Math.PI) / 360);

/** The vertical field of view a set of raw intrinsics implies, in degrees. */
export function fovFromRaw(raw: RawIntrinsics): number {
  return degOf(raw.ay, raw.height);
}

function usable(raw: RawIntrinsics | undefined): raw is RawIntrinsics {
  return Boolean(raw && raw.ay > 0 && raw.ax > 0 && raw.width > 0 && raw.height > 0);
}

/**
 * The best intrinsics available for a frame of this size.
 *
 * Raw intrinsics measured on an image of a different size are still this
 * camera's: scaled to the frame asked about. That scaling assumes the two
 * images cover the same view — the same crop of the same sensor — which held
 * on the device that produced both (886×1920 for the XR image, 1080×1920 for
 * the passthrough video: the same 1920 rows, a wider strip of them). It is an
 * assumption, and it is a far smaller one than twelve degrees.
 */
export function cameraIntrinsics(inputs: IntrinsicsInputs): CameraIntrinsics {
  const { frame, raw, xrFovDeg, operatorFovDeg } = inputs;
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);

  if (usable(raw)) {
    const scale = height / raw.height;
    const fy = raw.ay * scale;
    return {
      fx: raw.ax * (width / raw.width),
      fy,
      // The principal point where the platform put it, in this frame's pixels.
      cx: raw.u0 * (width / raw.width),
      cy: raw.v0 * scale,
      width,
      height,
      fovDeg: degOf(fy, height),
      source: 'xr-raw',
    };
  }

  const measured = xrFovDeg && xrFovDeg > 1 && xrFovDeg < 179 ? xrFovDeg : undefined;
  const operator = operatorFovDeg && operatorFovDeg > 1 && operatorFovDeg < 179
    && operatorFovDeg !== ASSUMED_FOV_DEG ? operatorFovDeg : undefined;
  const fovDeg = measured ?? operator ?? ASSUMED_FOV_DEG;
  const source: IntrinsicsSource = measured ? 'xr-camera' : operator ? 'operator' : 'assumed';
  const f = focalOf(fovDeg, height);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height, fovDeg, source };
}

/** Whether this is a measurement of the device, rather than a stand-in for one. */
export function isMeasured(source: IntrinsicsSource): boolean {
  return source === 'xr-raw' || source === 'xr-camera';
}
