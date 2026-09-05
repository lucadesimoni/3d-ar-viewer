import { downsample2, matchPatch, samplePatch, toGray, type GrayImage, type Patch } from './imageOps';
import type { GridObservation, Point2 } from './gridRecognition';

/**
 * Follows a recognised grid facade from frame to frame.
 *
 * Detection answers "is the shelf there and where", and run at one or two hertz
 * it leaves the overlay standing still between answers while the operator moves.
 * Tracking answers the easier question "where did it go since last frame" — a
 * short search around each point's last position — cheap enough to run on every
 * frame. The result is a pose that follows the object continuously, which on iOS
 * is the closest thing to the world tracking ARKit does natively and Safari will
 * not expose.
 *
 * Speed is not actually the main argument: measured on a 480x360 frame the two
 * cost about the same — roughly 3 ms to track, 2.4 ms to detect, which at 30 Hz
 * is under a tenth of a core. What tracking buys is continuity and freedom from
 * the detector's constraints — the lattice fit only works on a facade seen roughly
 * square-on, while tracked points feed a full homography, so once the lock
 * exists it survives the operator walking around to an oblique angle, and
 * survives losing part of the object behind a hand.
 *
 * Points tracked are the lattice intersections, because they are the strongest
 * corners the object has, and their positions on the object are *known* in
 * metres — the pitch comes from the BOM — so each one is a full model-to-image
 * correspondence rather than an anonymous feature.
 *
 * Two properties keep it from drifting the way a naive patch tracker does:
 *
 *  - after each frame the points are snapped back onto the homography that
 *    best explains them, so per-point error cannot accumulate — the object's
 *    own rigid geometry is the correction;
 *  - templates are re-cut from the current frame at those corrected positions,
 *    so the appearance stays current as the viewing angle changes, without the
 *    template being allowed to wander off the corner it belongs to.
 */

export interface TrackedFrame {
  /** Point positions on the object, metres, in the model plane. */
  model: Point2[];
  /** Where they are in this frame, in source-image pixels. */
  image: Point2[];
  /** 0..1 — share of points that matched, tempered by the fit residual. */
  confidence: number;
  /** Mean match score of the points that survived, -1..1. */
  meanScore: number;
}

export interface LatticeTrackerOptions {
  /** Longest side the tracker works at. Smaller is faster and blurrier. */
  workingSize?: number;
  /** Half-size of the correlation template, working pixels. */
  patchRadius?: number;
  /** How far a point may move between frames, *coarse* pixels (= 2 working). */
  searchRadius?: number;
  /** Reject a point whose match falls below this correlation. */
  minScore?: number;
  /** Reject a point sitting this far off the fitted homography, working px. */
  maxResidualPx?: number;
}

interface TrackPoint {
  model: Point2;
  image: Point2;      // working-image pixels
  patch: Patch | undefined;
  /** The same neighbourhood at half resolution, for the coarse pass. */
  coarse: Patch | undefined;
  ok: boolean;
  score: number;
}

/** Solve for the homography and reproject — imported lazily to avoid a cycle. */
type Homography = (src: Point2[], dst: Point2[]) => number[][] | undefined;

export class LatticeTracker {
  private points: TrackPoint[] = [];
  private working: number;
  private readonly patchRadius: number;
  private readonly searchRadius: number;
  private readonly minScore: number;
  private readonly maxResidual: number;
  private scale = 1;

  constructor(
    private readonly solveHomography: Homography,
    opts: LatticeTrackerOptions = {},
  ) {
    this.working = opts.workingSize ?? 320;
    this.patchRadius = opts.patchRadius ?? 5;
    this.searchRadius = opts.searchRadius ?? 7;
    this.minScore = opts.minScore ?? 0.6;
    this.maxResidual = opts.maxResidualPx ?? 3;
  }

  get tracking(): boolean {
    return this.points.length >= 4;
  }

  reset(): void {
    this.points = [];
  }

  /**
   * Take a fresh detection as the truth and start tracking from it.
   *
   * A 3x3 spread of lattice lines is enough: four points determine the
   * homography, nine leave room to lose several to a hand, a reflection or the
   * edge of the frame and still fit one.
   */
  seed(
    image: ImageData,
    obs: GridObservation,
    target: { cols: number; rows: number; widthM: number; heightM: number },
  ): boolean {
    const gray = toGray(image, this.working);
    const coarse = downsample2(gray);
    this.scale = gray.scale;
    const xi = spread(obs.xLines.length);
    const yi = spread(obs.yLines.length);

    const points: TrackPoint[] = [];
    for (const j of yi) {
      for (const i of xi) {
        const px = obs.xLines[i] / gray.scale;
        const py = obs.yLines[j] / gray.scale;
        const patch = samplePatch(gray, px, py, this.patchRadius);
        if (!patch || patch.norm < 1e-3) continue;
        const coarsePatch = samplePatch(coarse, px / 2, py / 2, COARSE_PATCH_RADIUS);
        points.push({
          // Model plane, y down, origin at the lattice centre — the convention
          // `rectModelCorners` uses, so the same pose solver serves both.
          model: {
            x: -target.widthM / 2 + (i / obs.cols) * target.widthM,
            y: -target.heightM / 2 + (j / obs.rows) * target.heightM,
          },
          image: { x: px, y: py },
          patch,
          coarse: coarsePatch,
          ok: true,
          score: 1,
        });
      }
    }
    this.points = points.length >= 4 ? points : [];
    return this.tracking;
  }

  /**
   * Find every point again, coarse first and then fine.
   *
   * A single-level search has to choose between covering enough ground and
   * staying accurate, and on a repeating pattern like a shelf front it loses
   * both ways: too small a window and a fast pan puts the point outside it, at
   * which point the correlation happily settles on a plausible wrong crossing
   * near the window's edge — and because every point fails in the same
   * direction, the wrong matches agree with each other well enough to fit a
   * homography and produce a confident, wrong pose.
   *
   * Searching at half resolution first covers four times the area for the same
   * radius and gets within a pixel or two; the fine pass then only has to
   * refine, so it can use a tight window that cannot reach the neighbouring
   * crossing.
   */
  private matchAll(
    fine: GrayImage,
    coarse: GrayImage,
    searchRadius: number,
  ): { matched: number; scoreSum: number } {
    let matched = 0;
    let scoreSum = 0;
    for (const p of this.points) {
      p.ok = false;
      if (!p.patch) continue;

      let guess = p.image;
      if (p.coarse) {
        const rough = matchPatch(coarse, p.coarse, p.image.x / 2, p.image.y / 2, searchRadius);
        if (rough) guess = { x: rough.x * 2, y: rough.y * 2 };
      }
      const hit = matchPatch(fine, p.patch, guess.x, guess.y, FINE_SEARCH_RADIUS);
      if (!hit || hit.score < this.minScore) continue;
      p.image = { x: hit.x, y: hit.y };
      p.score = hit.score;
      p.ok = true;
      matched++;
      scoreSum += hit.score;
    }
    return { matched, scoreSum };
  }

  /**
   * Advance to the next frame. Returns the correspondences for this frame, or
   * undefined when too little of the object could be found — at which point the
   * caller should fall back to a full detection rather than trust a stale pose.
   */
  track(image: ImageData): TrackedFrame | undefined {
    if (!this.tracking) return undefined;
    const gray = toGray(image, this.working);
    if (gray.scale !== this.scale) return undefined;   // resolution changed under us
    const coarse = downsample2(gray);

    // One normal pass, then — only if that failed — one wide one. The frame
    // rate on a tablet is not constant: a dropped frame doubles how far
    // everything moved, and giving up there would mean a full re-detection and
    // a visible hitch every time the browser is busy.
    //
    // The retry restarts from where the points were, not from wherever the
    // failed pass left them: letting the two searches compound turns a bounded
    // motion budget into a random walk that can cross a whole lattice pitch and
    // lock onto the wrong crossing.
    const before = this.points.map((p) => ({ ...p.image }));
    let { matched, scoreSum } = this.matchAll(gray, coarse, this.searchRadius);
    if (matched < 4) {
      this.points.forEach((p, i) => { p.image = before[i]; });
      ({ matched, scoreSum } = this.matchAll(gray, coarse, this.searchRadius * 2));
    }
    if (matched < 4) { this.reset(); return undefined; }

    // Throw away points that moved unlike the rest before fitting anything: a
    // template that latched onto a passing hand, or onto the wrong crossing of
    // a repeating pattern, shows up here as a displacement nothing else shares.
    const moved = this.points
      .map((p, i) => (p.ok ? Math.hypot(p.image.x - before[i].x, p.image.y - before[i].y) : NaN))
      .filter((d) => !Number.isNaN(d));
    const median = quantile(moved, 0.5);
    const deviation = quantile(moved.map((d) => Math.abs(d - median)), 0.5);
    const limit = Math.max(4, median + 3 * Math.max(1, deviation));
    this.points.forEach((p, i) => {
      if (!p.ok) return;
      if (Math.hypot(p.image.x - before[i].x, p.image.y - before[i].y) > limit) { p.ok = false; matched--; }
    });
    if (matched < 4) { this.reset(); return undefined; }

    // Fit the object's rigid geometry to what was found, and throw away points
    // that disagree with it — a patch that latched onto a passing hand shows up
    // here as a large residual, not as a wrong pose.
    let inliers = this.points.filter((p) => p.ok);
    if (!wellSpread(inliers)) { this.reset(); return undefined; }
    let H = this.solveHomography(inliers.map((p) => p.model), inliers.map((p) => p.image));
    if (!H) { this.reset(); return undefined; }

    const residual = (p: TrackPoint, h: number[][]): number => {
      const q = project(h, p.model);
      return Math.hypot(q.x - p.image.x, q.y - p.image.y);
    };
    const kept = inliers.filter((p) => residual(p, H!) <= this.maxResidual);
    if (kept.length >= 4 && kept.length < inliers.length && wellSpread(kept)) {
      const refit = this.solveHomography(kept.map((p) => p.model), kept.map((p) => p.image));
      if (refit) { H = refit; inliers = kept; }
    }

    // Snap every point — including the ones that failed to match — back onto
    // the fitted geometry, and re-cut its template there. This is what stops
    // the slow slide a patch tracker otherwise develops, and it quietly
    // recovers points that were briefly occluded or off-frame.
    for (const p of this.points) {
      const q = project(H, p.model);
      if (q.x < 0 || q.y < 0 || q.x >= gray.width || q.y >= gray.height) {
        p.patch = undefined;
        p.coarse = undefined;
        p.image = q;
        continue;
      }
      p.image = q;
      p.patch = samplePatch(gray, q.x, q.y, this.patchRadius) ?? p.patch;
      p.coarse = samplePatch(coarse, q.x / 2, q.y / 2, COARSE_PATCH_RADIUS) ?? p.coarse;
    }

    const meanScore = scoreSum / matched;
    const coverage = inliers.length / this.points.length;
    return {
      model: inliers.map((p) => p.model),
      image: inliers.map((p) => ({ x: p.image.x * this.scale, y: p.image.y * this.scale })),
      confidence: Math.max(0, Math.min(1, coverage * Math.max(0, meanScore))),
      meanScore,
    };
  }
}

/**
 * Are these points spread over enough of the object to pin a homography down?
 *
 * Points confined to two columns leave the perspective across the object
 * unconstrained: any fit through them is consistent, including one built from
 * matches that landed on the wrong crossing of a repeating pattern. Demanding
 * three distinct positions on each axis is what turns that silent wrong pose
 * into an honest loss of lock.
 */
function wellSpread(points: { model: Point2 }[]): boolean {
  const xs = new Set(points.map((p) => p.model.x.toFixed(4)));
  const ys = new Set(points.map((p) => p.model.y.toFixed(4)));
  return xs.size >= 3 && ys.size >= 3;
}

/** Linear-interpolation-free quantile of an unsorted list. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** Template half-size at half resolution; covers the same ground as the fine one. */
const COARSE_PATCH_RADIUS = 4;
/** Fine pass only refines, so it must not be able to reach the next crossing. */
const FINE_SEARCH_RADIUS = 3;

/** Apply a homography to a point. */
function project(H: number[][], p: Point2): Point2 {
  const w = H[2][0] * p.x + H[2][1] * p.y + H[2][2];
  return {
    x: (H[0][0] * p.x + H[0][1] * p.y + H[0][2]) / w,
    y: (H[1][0] * p.x + H[1][1] * p.y + H[1][2]) / w,
  };
}

/** First, middle and last index of `n` lines — a 3x3 spread over the object. */
function spread(n: number): number[] {
  if (n <= 3) return Array.from({ length: n }, (_, i) => i);
  return [0, Math.floor((n - 1) / 2), n - 1];
}

/** Re-exported so callers can size their frames to what the tracker wants. */
export const DEFAULT_TRACKER_WORKING_SIZE = 320;
export type { GrayImage };
