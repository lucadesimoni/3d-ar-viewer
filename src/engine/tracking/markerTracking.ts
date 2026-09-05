import { Matrix4, Quaternion, Vector3 } from 'three';
import { matrixToPose } from '../math';
import type { Pose } from '../types';

/**
 * Six-DoF pose of a printed fiducial, recovered from a single camera frame.
 *
 * The device gives us the four corners of a QR code (via `BarcodeDetector`); the
 * marker's physical side length gives us scale; from there it is a textbook
 * planar-homography pose recovery. This is what lets the app re-lock onto the
 * workpiece after the operator walks away and back, without asking them to
 * re-touch datums — the single biggest usability gap in sensor-only AR on iOS.
 */

export interface Point2 {
  x: number;
  y: number;
}

export interface Intrinsics {
  /** Focal length in pixels (square pixels assumed). */
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface MarkerObservation {
  id: string;
  pose: Pose;
  /** Mean reprojection error in pixels — the honest quality number. */
  reprojectionPx: number;
  /** Apparent side length in pixels; small markers give noisy poses. */
  apparentPx: number;
  observedAtMs: number;
}

/**
 * Pinhole intrinsics from the video size and an assumed vertical field of view.
 *
 * Browsers do not expose the real camera calibration, so this is an estimate;
 * a 5-degree FOV error shows up as roughly a 10% range error, which is why the
 * result is used for *re-registration* against a known anchor rather than as a
 * primary measurement.
 */
export const ASSUMED_CAMERA_FOV_DEG = 60;

export function estimateIntrinsics(width: number, height: number, fovDeg = ASSUMED_CAMERA_FOV_DEG): Intrinsics {
  const f = height / 2 / Math.tan((fovDeg * Math.PI) / 360);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2 };
}

/** Solve an 8x8 linear system by Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return undefined; // singular
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const p = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }

  return m.map((row) => row[n]);
}

/**
 * Homography mapping four planar source points to four image points.
 *
 * Returned row-major as a 3x3 with `h22` fixed at 1.
 */
export function solveHomography(src: Point2[], dst: Point2[]): number[][] | undefined {
  if (src.length !== 4 || dst.length !== 4) return undefined;
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const h = solveLinear(A, b);
  if (!h) return undefined;
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

const mulKInv = (K: Intrinsics, v: number[]): Vector3 =>
  new Vector3((v[0] - K.cx * v[2]) / K.fx, (v[1] - K.cy * v[2]) / K.fy, v[2]);

/**
 * Decompose a planar homography into a rigid pose, given the intrinsics.
 *
 * The two recovered rotation columns are not exactly orthonormal because of
 * pixel noise, so they are re-orthonormalised before the third is completed by
 * cross product — skipping that step produces quaternions that visibly shear
 * the overlay.
 */
export function poseFromHomography(H: number[][], K: Intrinsics): Pose | undefined {
  const h1 = mulKInv(K, [H[0][0], H[1][0], H[2][0]]);
  const h2 = mulKInv(K, [H[0][1], H[1][1], H[2][1]]);
  const h3 = mulKInv(K, [H[0][2], H[1][2], H[2][2]]);

  const norm = (h1.length() + h2.length()) / 2;
  if (norm < 1e-9) return undefined;
  const lambda = 1 / norm;

  let r1 = h1.multiplyScalar(lambda);
  let r2 = h2.multiplyScalar(lambda);
  const t = h3.multiplyScalar(lambda);

  // Symmetric orthonormalisation: rather than fix r1 and bend r2 onto it, split
  // the error between them. `orth` must be the in-plane vector that leads mid
  // towards r1 — cross(mid, normal), in that order. With the operands the other
  // way round it points the opposite way, which swaps r1 and r2 and hands back
  // a basis rotated 90 degrees about the view axis. That was the overlay lying
  // on its side; the round-trip test in poseRecovery.test.ts pins it down.
  const mid = r1.clone().add(r2).normalize();
  const normal = new Vector3().crossVectors(r1, r2).normalize();
  const orth = new Vector3().crossVectors(mid, normal).normalize();
  r1 = mid.clone().add(orth).normalize();
  r2 = mid.clone().sub(orth).normalize();

  // The marker must be in front of the camera. In this frame — OpenCV's, since
  // the intrinsics map straight to pixels with y down — "in front" is z > 0.
  //
  // Negating the third column as well is what made the basis left-handed: with
  // r3 flipped it no longer equals r1 x r2, `makeBasis` produced a matrix with
  // determinant -1, and the quaternion pulled out of it was a reflection
  // wearing a rotation's clothes. Downstream that showed up as an overlay
  // rolled 90 degrees onto its side. Flip only the two solved columns, then
  // rebuild the third from them.
  if (t.z < 0) {
    r1.negate();
    r2.negate();
    t.negate();
  }
  const r3 = new Vector3().crossVectors(r1, r2).normalize();

  const m = new Matrix4().makeBasis(r1, r2, r3);
  m.setPosition(t);
  const pose = matrixToPose(m);
  // Renormalise: makeBasis on near-orthonormal vectors still leaves tiny scale.
  const q = new Quaternion(...pose.rotation).normalize();
  return { position: pose.position, rotation: [q.x, q.y, q.z, q.w] };
}

/** Mean reprojection error of the four corners under `H`. */
export function reprojectionError(H: number[][], src: Point2[], dst: Point2[]): number {
  let total = 0;
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i];
    const w = H[2][0] * x + H[2][1] * y + H[2][2];
    const u = (H[0][0] * x + H[0][1] * y + H[0][2]) / w;
    const v = (H[1][0] * x + H[1][1] * y + H[1][2]) / w;
    total += Math.hypot(u - dst[i].x, v - dst[i].y);
  }
  return total / src.length;
}

/**
 * Corner points of a `widthM` x `heightM` rectangle centred on its own origin,
 * in TL, TR, BR, BL order with **y increasing downwards**.
 *
 * Matching the image's own axis direction is deliberate. The homography then
 * maps a right-handed model frame onto a right-handed camera frame, and the
 * decomposition comes out as a plain rotation. Using a y-up model frame against
 * a y-down image sneaks a reflection into the middle of the solve, which is not
 * a rotation and cannot be recovered as one.
 */
export const rectModelCorners = (widthM: number, heightM: number): Point2[] => {
  const w = widthM / 2;
  const h = heightM / 2;
  return [
    { x: -w, y: -h },
    { x: w, y: -h },
    { x: w, y: h },
    { x: -w, y: h },
  ];
};

/**
 * Convert a pose measured in the OpenCV camera frame (x right, y **down**,
 * z forward, right-handed) into the renderer's camera frame (x right, y **up**,
 * z forward, left-handed).
 *
 * Flipping one axis is a handedness change, so the quaternion is conjugated
 * rather than copied: negating y takes (x, y, z, w) to (-x, y, -z, w).
 *
 * The plane's own frame flips with it, and lands on the renderer's convention:
 * +X right across the face, +Y up it, **+Z into the object, away from the
 * viewer**. That is what `poseInAssembly` on a marker or a recognition target
 * has to be expressed in — a frame with +Z out towards the viewer alongside
 * +X right and +Y up is right-handed and simply does not exist in a
 * left-handed scene.
 */
export function cvPoseToRenderer(pose: Pose): Pose {
  const [x, y, z] = pose.position;
  const [qx, qy, qz, qw] = pose.rotation;
  return { position: [x, -y, z], rotation: [-qx, qy, -qz, qw] };
}

/** Corner points of a marker of side `sizeM`, centred on its own origin, Z up. */
export const markerModelCorners = (sizeM: number): Point2[] => rectModelCorners(sizeM, sizeM);

/**
 * Pose of a known planar rectangle in the camera frame, from its four image
 * corners in TL, TR, BR, BL order.
 *
 * The same solve serves a printed fiducial and a recognised object facade — a
 * QR code is just a rectangle whose size you happen to know, and so is the front
 * of a cube shelf. Keeping one implementation means the object path inherits the
 * marker path's re-orthonormalisation and reprojection quality metric.
 *
 * The returned pose is already in the renderer's camera frame (see
 * `cvPoseToRenderer`), so callers hand it straight to the scene without any
 * further axis juggling.
 */
export function rectPoseFromCorners(
  corners: Point2[],
  widthM: number,
  heightM: number,
  K: Intrinsics,
): { pose: Pose; reprojectionPx: number; apparentPx: number } | undefined {
  if (corners.length !== 4) return undefined;
  const model = rectModelCorners(widthM, heightM);
  const H = solveHomography(model, corners);
  if (!H) return undefined;
  const cvPose = poseFromHomography(H, K);
  if (!cvPose) return undefined;
  const pose = cvPoseToRenderer(cvPose);

  let perimeter = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    perimeter += Math.hypot(a.x - b.x, a.y - b.y);
  }

  return {
    pose,
    reprojectionPx: reprojectionError(H, model, corners),
    apparentPx: perimeter / 4,
  };
}

/** Pose of a marker in the camera frame from its four detected image corners. */
export function markerPoseFromCorners(
  corners: Point2[],
  sizeM: number,
  K: Intrinsics,
): { pose: Pose; reprojectionPx: number; apparentPx: number } | undefined {
  return rectPoseFromCorners(corners, sizeM, sizeM, K);
}

type BarcodeCtor = new (opts?: { formats?: string[] }) => {
  detect(source: CanvasImageSource): Promise<
    { rawValue: string; cornerPoints: Point2[] }[]
  >;
};

/**
 * Polls the passthrough video for QR fiducials.
 *
 * Detection runs at a deliberately low rate: the value here is a periodic
 * correction to a sensor-driven pose, not a per-frame tracker, and hammering
 * `BarcodeDetector` on a tablet is a fast route to a hot device and a dead
 * battery mid-shift.
 */
export class MarkerTracker {
  private detector: InstanceType<BarcodeCtor> | undefined;
  private timer: number | undefined;
  private busy = false;

  readonly supported: boolean;

  constructor(
    private readonly sizeM: number,
    private readonly onObservation: (obs: MarkerObservation) => void,
    private readonly fovDeg = 60,
  ) {
    const ctor = (window as unknown as { BarcodeDetector?: BarcodeCtor }).BarcodeDetector;
    this.supported = typeof ctor === 'function';
    if (ctor) {
      try {
        this.detector = new ctor({ formats: ['qr_code'] });
      } catch {
        this.detector = undefined;
      }
    }
  }

  start(video: HTMLVideoElement, intervalMs = 600): void {
    if (!this.detector) return;
    this.stop();
    this.timer = window.setInterval(() => void this.scan(video), intervalMs);
  }

  private async scan(video: HTMLVideoElement): Promise<void> {
    if (!this.detector || this.busy || video.readyState < 2) return;
    this.busy = true;
    try {
      const results = await this.detector.detect(video);
      const K = estimateIntrinsics(video.videoWidth, video.videoHeight, this.fovDeg);
      for (const r of results) {
        const solved = markerPoseFromCorners(r.cornerPoints, this.sizeM, K);
        if (!solved) continue;
        // A tiny marker in frame gives a pose dominated by corner noise.
        if (solved.apparentPx < 40 || solved.reprojectionPx > 6) continue;
        this.onObservation({
          id: r.rawValue,
          pose: solved.pose,
          reprojectionPx: solved.reprojectionPx,
          apparentPx: solved.apparentPx,
          observedAtMs: Date.now(),
        });
      }
    } catch {
      // Detection failures are routine (frame not ready, format unsupported).
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }
}
