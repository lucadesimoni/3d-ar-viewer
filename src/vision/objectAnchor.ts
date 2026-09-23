import { detectGridFacade, detectLeveledGridFacade, matchesGridTarget, type GridObservation, type Point2 } from './gridRecognition';
import { faceSquareOn, IDENTITY_LEVELING, levelingHomography, turnAboutVertical, type Leveling } from './leveling';
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
 *
 * That measurement was taken against `ar-verify`'s synthetic sway, which
 * moves the drawn object but not the camera. A real device log showed the
 * gap: a handheld phone being aimed at a target moves *itself* by more than
 * this between two detection intervals as a matter of course, and the frames
 * used to compare directly in camera space — measuring the phone's own
 * motion, not the object's. Fixed by comparing in world space instead (see
 * `update()`); this budget still describes real, in-world disagreement, not
 * the operator's hand.
 */
const AGREEMENT_M = 0.2;

/**
 * Below this, the camera counts as level and the leveled pass is skipped: the
 * plain detector's own tolerance (about 20 degrees) covers it, and resampling
 * would only blur the edges it measures.
 */
const LEVEL_MIN_TILT_DEG = 5;
/** Above this, the plain detector's pose is too wrong to fall back on. */
const PLAIN_MAX_TILT_DEG = 10;
/** Directions to try when a facade is too far to the side to be found square-on. */
const YAW_GUESSES_DEG = [-20, 20, -32, 32];

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
  /** `pose` here is in world space, not camera space — see `update()`. */
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
   * Find the target in a frame. A camera held level uses the plain detector,
   * exactly as before; a tipped one looks in the view leveled by gravity,
   * because only there is the facade the rectangle the detector fits.
   */
  private detect(
    image: ImageData,
    K: { fx: number; fy: number; cx: number; cy: number },
    cameraToWorld: (pose: Pose) => Pose,
  ): { obs: GridObservation; toImage?: (p: Point2) => Point2 | undefined } | undefined {
    const rotation = cameraToWorld({ position: [0, 0, 0], rotation: [0, 0, 0, 1] }).rotation;
    const level = levelingHomography(rotation, K);
    let found: { obs: GridObservation; toImage?: (p: Point2) => Point2 | undefined } | undefined;
    const tipped = level !== undefined && level.tiltDeg >= LEVEL_MIN_TILT_DEG;
    let used: Leveling = tipped ? level : IDENTITY_LEVELING;
    if (level && tipped) {
      const leveled = detectLeveledGridFacade(image, level, K, { target: this.target });
      if (leveled && matchesGridTarget(leveled.obs, this.target)) found = leveled;
    }
    // A tilted camera turns the facade into a trapezoid, and the plain
    // detector's rectangle around it is a wrong pose, not an approximate one:
    // measured, 7.6% of the range at 30 degrees of pitch and 127% with the
    // phone rolled 25 degrees — a confident lock in the wrong place. Only a
    // slight tilt may fall back to it.
    if (!found && (!tipped || level!.tiltDeg <= PLAIN_MAX_TILT_DEG)) {
      const plain = detectGridFacade(image, { target: this.target });
      if (plain && matchesGridTarget(plain, this.target)) found = { obs: plain };
    }
    if (!found) {
      // Seen from much more than 15 degrees to the side, the bays shrink so
      // much with distance that no even lattice fits them, and there are no
      // board slopes yet to say which way the facade faces. Guess a few
      // directions; whichever finds it is then refined below.
      for (const yaw of YAW_GUESSES_DEG) {
        const turned = turnAboutVertical(used, yaw, K);
        const guess = detectLeveledGridFacade(image, turned, K, { target: this.target });
        if (guess && matchesGridTarget(guess.obs, this.target)) {
          found = guess;
          used = turned;
          break;
        }
      }
      if (!found) return undefined;
    }
    // Seen from the side, the facade is still a trapezoid after leveling; its
    // across-boards say which way it faces. Look again square-on to it, and
    // keep the first answer if that does not work out.
    const rows = found.obs.grid?.map((r) => [r[0], r[r.length - 1]] as [Point2, Point2]);
    const square = rows && faceSquareOn(used, rows, K);
    if (square) {
      const again = detectLeveledGridFacade(image, square, K, { target: this.target });
      if (again && matchesGridTarget(again.obs, this.target)) return again;
    }
    return found;
  }

  /**
   * Feed one camera frame. Returns a pose whenever there is one to report —
   * every frame while tracking, and at the detection cadence otherwise.
   *
   * `cameraToWorld` is optional and defaults to the identity — every existing
   * caller and test that omits it keeps today's behaviour exactly, since
   * camera space and world space then coincide. Pass the renderer's real
   * transform (`SceneManager.cameraToWorld`) to acquire correctly: see the
   * note on `AGREEMENT_M` below for why this matters.
   */
  update(
    image: ImageData,
    nowMs: number,
    fovDeg?: number,
    cameraToWorld: (pose: Pose) => Pose = (pose) => pose,
  ): ObjectObservation | undefined {
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

    const found = this.detect(image, K, cameraToWorld);
    if (!found) {
      this.pending = undefined;
      return undefined;
    }
    const { obs, toImage } = found;
    const quad = toImage ? obs.quad.map(toImage) : obs.quad;
    if (quad.some((p) => p === undefined)) {
      this.pending = undefined;
      return undefined;
    }
    const solved = rectPoseFromCorners(quad as Point2[], this.target.widthM, this.target.heightM, K);
    if (!solved || solved.reprojectionPx > 6) return undefined;

    // A detection that agrees with the one before it extends the run; one that
    // does not — or one that arrives after the previous has gone stale — starts
    // a new run at this pose rather than throwing the evidence away.
    //
    // Compared in world space, not the camera space `solved.pose` arrives in —
    // a real device log showed why: an operator aiming the phone moves the
    // camera between two detection intervals (400-1000 ms apart) by more than
    // `AGREEMENT_M` relative to itself, even while the shelf sits perfectly
    // still in the world. Comparing camera-space positions across frames from
    // different camera poses was measuring the phone's own motion, not the
    // object's — three real, correct detections in a row could never agree.
    const worldPose = cameraToWorld(solved.pose);
    const previous = this.pending;
    const fresh = previous !== undefined && nowMs - previous.atMs <= 4000;
    const drift = fresh ? Math.hypot(
      worldPose.position[0] - previous.pose.position[0],
      worldPose.position[1] - previous.pose.position[1],
      worldPose.position[2] - previous.pose.position[2],
    ) : Infinity;
    const streak = drift <= (this.opts.agreementM ?? AGREEMENT_M) ? previous!.streak + 1 : 1;
    this.pending = { pose: worldPose, atMs: nowMs, streak };
    if (streak < (this.opts.agreeFrames ?? AGREE_FRAMES)) return undefined;

    // Enough frames agree: commit, and hand the detection to the tracker so the
    // next frames are followed rather than searched for.
    this.locked = this.tracker.seed(image, obs, this.target, toImage);
    return {
      pose: solved.pose,
      confidence: Math.max(0, Math.min(1, obs.confidence * (1 - solved.reprojectionPx / 8))),
      mode: 'detected',
      reprojectionPx: solved.reprojectionPx,
    };
  }
}
