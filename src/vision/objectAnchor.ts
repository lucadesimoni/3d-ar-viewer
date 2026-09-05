import { detectGridFacade, matchesGridTarget } from './gridRecognition';
import { LatticeTracker } from './latticeTracker';
import {
  estimateIntrinsics,
  planePoseFromPoints,
  rectPoseFromCorners,
  solveHomography,
} from '../engine/tracking/markerTracking';
import type { GridTargetDef, Pose } from '../engine/types';

/**
 * Keeps the overlay stuck to a real object: detect it once, then follow it.
 *
 * The split matters for how the app feels. Detection searches the whole frame
 * and only works on a facade seen roughly square-on, so it runs at one or two
 * hertz and, on its own, leaves the overlay frozen between answers while the
 * operator walks. Tracking asks the narrower question of where each known point
 * moved since the last frame, so it can run on every frame and — because it
 * fits a full homography rather than an axis-aligned lattice — it holds as the
 * operator moves round to an oblique view. Detection becomes the thing that
 * acquires and re-acquires the lock, not the thing the overlay waits for.
 *
 * Acquisition takes two agreeing detections. One confident-looking lattice in a
 * window frame or a radiator would otherwise yank the assembly across the room;
 * demanding that a second frame agrees to within 200 mm costs a fraction of a
 * second and removes essentially every one-frame false positive.
 */

export type AnchorMode = 'detected' | 'tracked';

export interface ObjectObservation {
  /** Pose of the target's own frame, in the renderer's camera space. */
  pose: Pose;
  confidence: number;
  mode: AnchorMode;
  reprojectionPx: number;
}

export interface ObjectAnchorOptions {
  /** Assumed vertical field of view of the camera, degrees. */
  fovDeg?: number;
  /** How often a full detection may run while unlocked, ms. */
  detectIntervalMs?: number;
  /** Two detections must agree within this to acquire the lock, metres. */
  agreementM?: number;
  /** Drop the lock below this tracking confidence. */
  minTrackConfidence?: number;
  workingSize?: number;
}

export class ObjectAnchorTracker {
  private readonly tracker: LatticeTracker;
  private pending: { pose: Pose; atMs: number } | undefined;
  // Negative infinity, not zero: the very first frame must be allowed to run a
  // detection rather than sitting out the first interval doing nothing.
  private lastDetectMs = Number.NEGATIVE_INFINITY;
  private locked = false;

  constructor(
    private readonly target: GridTargetDef,
    private readonly opts: ObjectAnchorOptions = {},
  ) {
    this.tracker = new LatticeTracker(solveHomography, { workingSize: opts.workingSize });
  }

  get hasLock(): boolean {
    return this.locked && this.tracker.tracking;
  }

  reset(): void {
    this.tracker.reset();
    this.locked = false;
    this.pending = undefined;
  }

  /** Camera calibration can change while running (the settings slider). */
  private intrinsics(image: ImageData, fovDeg: number | undefined) {
    return estimateIntrinsics(image.width, image.height, fovDeg ?? this.opts.fovDeg ?? 60);
  }

  /**
   * Feed one camera frame. Returns a pose whenever there is one to report —
   * every frame while tracking, and at the detection cadence otherwise.
   */
  update(image: ImageData, nowMs: number, fovDeg?: number): ObjectObservation | undefined {
    const K = this.intrinsics(image, fovDeg);
    if (this.hasLock) {
      const tracked = this.tracker.track(image);
      if (tracked) {
        const solved = planePoseFromPoints(tracked.model, tracked.image, K);
        if (solved && solved.reprojectionPx < 8) {
          return {
            pose: solved.pose,
            confidence: tracked.confidence,
            mode: 'tracked',
            reprojectionPx: solved.reprojectionPx,
          };
        }
      }
      // Lost it — fall through and try to re-acquire from scratch this frame.
      this.tracker.reset();
      this.locked = false;
      this.pending = undefined;
    }

    const interval = this.opts.detectIntervalMs ?? 500;
    if (nowMs - this.lastDetectMs < interval) return undefined;
    this.lastDetectMs = nowMs;

    const obs = detectGridFacade(image);
    if (!obs || !matchesGridTarget(obs, this.target)) {
      this.pending = undefined;
      return undefined;
    }
    const solved = rectPoseFromCorners(obs.quad, this.target.widthM, this.target.heightM, K);
    if (!solved || solved.reprojectionPx > 6) return undefined;

    const previous = this.pending;
    this.pending = { pose: solved.pose, atMs: nowMs };
    if (!previous || nowMs - previous.atMs > 4000) return undefined;
    const drift = Math.hypot(
      solved.pose.position[0] - previous.pose.position[0],
      solved.pose.position[1] - previous.pose.position[1],
      solved.pose.position[2] - previous.pose.position[2],
    );
    if (drift > (this.opts.agreementM ?? 0.2)) return undefined;

    // Two frames agree: commit, and hand the detection to the tracker so the
    // next frames are followed rather than searched for.
    this.locked = this.tracker.seed(image, obs, this.target);
    return {
      pose: solved.pose,
      confidence: Math.max(0, Math.min(1, obs.confidence * (1 - solved.reprojectionPx / 8))),
      mode: 'detected',
      reprojectionPx: solved.reprojectionPx,
    };
  }
}
