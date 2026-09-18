import { detectGridFacade, matchesGridTarget } from './gridRecognition';
import { LatticeTracker, type TrackedFrame } from './latticeTracker';
import {
  estimateIntrinsics,
  planePoseFromPoints,
  rectModelCorners,
  rectPoseFromCorners,
  solveHomography,
} from '../engine/tracking/markerTracking';
import { edgeField } from '../perception/edges';
import { quadAgreement, type Agreement } from '../perception/agreement';
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
 * Acquisition takes three agreeing detections. One confident-looking lattice in
 * a window frame or a radiator would otherwise yank the assembly across the
 * room, and the extra frame costs one detection interval — 400 to 1000 ms,
 * depending on what the performance profile allows.
 *
 * It was two, and a device log said two is not enough. A real 4x2 KALLAX with
 * two instrument cases standing on top of it: the cases' upper edge lands about
 * one cube pitch above the real top board, so the periodicity search reads it
 * as a fourth board line and the shelf comes back as three rows rather than
 * two. Most frames are then rejected outright on the bay count — the operator
 * sees "it does not snap" — but the misreading is *steady*, because the cases
 * are not going anywhere, so two consecutive detections agreeing on a wrong
 * lattice is not the freak event the two-frame rule assumed. The log caught
 * exactly that: `placement: recognized` at 0.94 confidence, with the overlay
 * sitting a row low and its bottom board buried in the floor.
 *
 * Three frames make a steady misreading less likely to land, and that is all
 * they do: this is a narrowing, not a fix. Clutter that sits still long enough
 * still gets through. The real answer is per-line contrast and coverage
 * scoring instead of one global period fit, which is Stage A's `agreement.ts`
 * and is not built yet.
 */

/** Consecutive detections that must agree before the lock is committed. */
const AGREE_FRAMES = 3;
/**
 * How far apart two consecutive detections may sit and still agree, metres.
 *
 * Tightening this to 0.15 alongside the third frame was tried and measured to
 * be wrong, so it is written down rather than left to be tried again. A
 * detection runs every `recognitionIntervalMs`, which is 400/600/1000 ms by
 * performance profile, and the target is allowed to be moving relative to the
 * camera — a walking operator, a shelf panned across the frame. On the
 * synthetic sway `ar-verify` uses, consecutive detections legitimately sit
 * 130 mm apart at 500 ms and about 260 mm at 1000 ms, so at the low profile
 * 0.15 admitted nothing: three in a row never agreed and the lock never
 * committed at all. 0.2 with three frames locks in 5.1 s on that same moving
 * target, against 2.0 s for the old two-frame rule.
 *
 * That 5.1 s is the worst case and it is a moving one. Real furniture holds
 * still, consecutive detections then land within millimetres of each other,
 * and the third frame costs one more interval — under a second.
 */
const AGREEMENT_M = 0.2;

export type AnchorMode = 'detected' | 'tracked';

export interface ObjectObservation {
  /** Pose of the target's own frame, in the renderer's camera space. */
  pose: Pose;
  confidence: number;
  mode: AnchorMode;
  reprojectionPx: number;
  /**
   * How well the image agrees with the outline this lock implies — present on
   * tracked frames, at the detection cadence, and never acted on.
   *
   * Reported rather than enforced on purpose. The measurement separates the
   * known-bad KALLAX lock from the real facade by a factor of two overall and
   * nearly twenty on the side that was actually wrong, but that is one bad pose
   * and one hand-measured good one out of a single frame. A threshold set from
   * that would drop good locks on the next device, which is a worse failure
   * than the one it would prevent — this session already paid for guessing a
   * number once. So the numbers go in the log first and the gate comes after
   * there are device sessions to calibrate it against.
   */
  agreement?: Agreement;
}

export interface ObjectAnchorOptions {
  /** Assumed vertical field of view of the camera, degrees. */
  fovDeg?: number;
  /** How often a full detection may run while unlocked, ms. */
  detectIntervalMs?: number;
  /** Consecutive detections must agree within this to acquire the lock, metres. */
  agreementM?: number;
  /** How many consecutive agreeing detections the lock costs. */
  agreeFrames?: number;
  /** Drop the lock below this tracking confidence. */
  minTrackConfidence?: number;
  workingSize?: number;
}

export class ObjectAnchorTracker {
  private readonly tracker: LatticeTracker;
  private pending: { pose: Pose; atMs: number; streak: number } | undefined;
  // Negative infinity, not zero: the very first frame must be allowed to run a
  // detection rather than sitting out the first interval doing nothing.
  private lastDetectMs = Number.NEGATIVE_INFINITY;
  private lastAgreementMs = Number.NEGATIVE_INFINITY;
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
   * Ask the image whether the outline this lock implies is really there.
   *
   * The outline is not the tracked points — checking those against the image
   * they were cut from would answer itself. It is the target's full extent,
   * carried out to its corners through the same homography the tracked points
   * fit. That is the step where a wrong lock gives itself away: the bad KALLAX
   * pose held real edges at the points it was following and put the bottom
   * board, which it had never seen, into the floor.
   */
  private measureAgreement(image: ImageData, tracked: TrackedFrame): Agreement | undefined {
    const H = solveHomography(tracked.model, tracked.image);
    if (!H) return undefined;
    const quad = rectModelCorners(this.target.widthM, this.target.heightM).map((p) => {
      const w = H[2][0] * p.x + H[2][1] * p.y + H[2][2];
      if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return undefined;
      return {
        x: (H[0][0] * p.x + H[0][1] * p.y + H[0][2]) / w,
        y: (H[1][0] * p.x + H[1][1] * p.y + H[1][2]) / w,
      };
    });
    if (quad.some((p) => p === undefined)) return undefined;
    return quadAgreement(edgeField(image, this.opts.workingSize), quad as { x: number; y: number }[]);
  }

  /**
   * Feed one camera frame. Returns a pose whenever there is one to report —
   * every frame while tracking, and at the detection cadence otherwise.
   */
  update(image: ImageData, nowMs: number, fovDeg?: number): ObjectObservation | undefined {
    const K = this.intrinsics(image, fovDeg);
    const interval = this.opts.detectIntervalMs ?? 500;
    if (this.hasLock) {
      const tracked = this.tracker.track(image);
      if (tracked) {
        const solved = planePoseFromPoints(tracked.model, tracked.image, K);
        if (solved && solved.reprojectionPx < 8) {
          // At the detection cadence, not per frame: this is a full pass over
          // the downsampled image, the same order of cost as the detection the
          // unlocked path spends there anyway.
          let agreement: Agreement | undefined;
          if (nowMs - this.lastAgreementMs >= interval) {
            this.lastAgreementMs = nowMs;
            agreement = this.measureAgreement(image, tracked);
          }
          return {
            pose: solved.pose,
            confidence: tracked.confidence,
            mode: 'tracked',
            reprojectionPx: solved.reprojectionPx,
            agreement,
          };
        }
      }
      // Lost it — fall through and try to re-acquire from scratch this frame.
      this.tracker.reset();
      this.locked = false;
      this.pending = undefined;
    }

    if (nowMs - this.lastDetectMs < interval) return undefined;
    this.lastDetectMs = nowMs;

    const obs = detectGridFacade(image);
    if (!obs || !matchesGridTarget(obs, this.target)) {
      this.pending = undefined;
      return undefined;
    }
    const solved = rectPoseFromCorners(obs.quad, this.target.widthM, this.target.heightM, K);
    if (!solved || solved.reprojectionPx > 6) return undefined;

    // A detection that agrees with the one before it extends the run; one that
    // does not — or one that arrives after the previous has gone stale — starts
    // a new run at this pose rather than throwing the evidence away.
    const previous = this.pending;
    const fresh = previous !== undefined && nowMs - previous.atMs <= 4000;
    const drift = fresh ? Math.hypot(
      solved.pose.position[0] - previous.pose.position[0],
      solved.pose.position[1] - previous.pose.position[1],
      solved.pose.position[2] - previous.pose.position[2],
    ) : Infinity;
    const streak = drift <= (this.opts.agreementM ?? AGREEMENT_M) ? previous!.streak + 1 : 1;
    this.pending = { pose: solved.pose, atMs: nowMs, streak };
    if (streak < (this.opts.agreeFrames ?? AGREE_FRAMES)) return undefined;

    // Enough frames agree: commit, and hand the detection to the tracker so the
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
