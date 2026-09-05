/**
 * Markerless recognition of a regular grid facade — a cube shelf, a drawer
 * bank, a patch panel, a rack of identical bays.
 *
 * Why not just run the object detector: a COCO-class detector will tell you
 * there is furniture somewhere in the frame, which is worth nothing to AR. To
 * anchor an overlay you need the object's *outline* and its *scale*, and a grid
 * facade hands you both for free — the openings are identical and their pitch is
 * a number straight out of the BOM. So instead of a bounding box we recover the
 * lattice itself: the vertical and horizontal board lines, how many bays they
 * enclose, and the outer rectangle they span. Combined with the known physical
 * width that is a full metric pose, exactly like a fiducial gives, and it runs
 * in a couple of milliseconds of plain JavaScript on any phone.
 *
 * The method is classical and deterministic: gradient energy projected onto each
 * axis gives two 1-D signals whose peaks are the board edges; a periodic lattice
 * is then fitted to those peaks by an exhaustive search over spacing and phase,
 * scored by inliers minus missing lines. That last part is what makes it robust
 * to clutter — a book leaning in one bay adds a stray peak, but it does not fit
 * the lattice, so it is ignored.
 *
 * Limitation, stated plainly: the lattice is axis-aligned, so the facade must be
 * roughly square-on to the camera (within about 20 degrees). That is the natural
 * way an operator stands in front of a shelf to align to it, and the recovered
 * pose is refined afterwards by the mate solver anyway. A perspective-tolerant
 * version needs full line-segment detection and a vanishing-point solve, which
 * is not worth the frame budget on a tablet.
 */

export interface Point2 {
  x: number;
  y: number;
}

export interface GridObservation {
  /**
   * Rectangle spanned by the outermost lattice lines, image pixels, ordered
   * TL, TR, BR, BL.
   *
   * A board presents two edges, and depending on the working resolution the fit
   * may lock onto the left edges, the right edges, or the merged centres of the
   * board family. The *span* is identical in all three cases — it is always a
   * whole number of pitches — so scale and therefore range are unaffected; only
   * the rectangle's centre can sit up to half a board thickness off, which is
   * 15 mm on a cube shelf and well inside what the mate solver absorbs.
   */
  quad: Point2[];
  /** Openings across and down (lines minus one). */
  cols: number;
  rows: number;
  /** Detected board-line positions, image pixels. */
  xLines: number[];
  yLines: number[];
  /** 0..1 — how completely the fitted lattice is actually supported by edges. */
  confidence: number;
}

export interface GridDetectOptions {
  /** Longest side the analysis runs at; frames are box-downsampled to it. */
  workingSize?: number;
  /** Reject lattices with fewer than this many openings per axis. */
  minCells?: number;
  maxCells?: number;
  /** Peak must exceed mean + this many standard deviations of the profile. */
  peakSigma?: number;
}

interface Lattice {
  positions: number[];
  spacing: number;
  coverage: number;
}

/** Luma of an RGBA frame, box-downsampled so the cost is bounded. */
function grayscale(image: ImageData, workingSize: number): { g: Float32Array; w: number; h: number; scale: number } {
  const step = Math.max(1, Math.ceil(Math.max(image.width, image.height) / workingSize));
  const w = Math.floor(image.width / step);
  const h = Math.floor(image.height / step);
  const g = new Float32Array(w * h);
  const d = image.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let sy = 0; sy < step; sy++) {
        const row = (y * step + sy) * image.width;
        for (let sx = 0; sx < step; sx++) {
          const i = (row + x * step + sx) * 4;
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
      }
      g[y * w + x] = sum / (step * step);
    }
  }
  return { g, w, h, scale: step };
}

/** Column-wise vertical-edge energy and row-wise horizontal-edge energy. */
function edgeProfiles(g: Float32Array, w: number, h: number): { cols: Float32Array; rows: Float32Array } {
  const cols = new Float32Array(w);
  const rows = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      cols[x] += Math.abs(g[i + 1] - g[i - 1]);
      rows[y] += Math.abs(g[i + w] - g[i - w]);
    }
  }
  return { cols: smooth(cols), rows: smooth(rows) };
}

/** Three-tap box blur — collapses the double edge of a board into one peak. */
function smooth(p: Float32Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) {
    const a = p[Math.max(0, i - 1)];
    const c = p[Math.min(p.length - 1, i + 1)];
    out[i] = (a + p[i] + c) / 3;
  }
  return out;
}

/** Local maxima that stand clear of the profile's own noise floor. */
export function findPeaks(profile: Float32Array, sigma = 0.8, minSeparation = 3): number[] {
  const n = profile.length;
  if (n < 3) return [];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += profile[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (profile[i] - mean) ** 2;
  const std = Math.sqrt(variance / n);
  const threshold = mean + sigma * std;

  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (profile[i] < threshold) continue;
    if (profile[i] < profile[i - 1] || profile[i] < profile[i + 1]) continue;
    // Sub-pixel refinement by the parabola through the three samples: board
    // lines are a couple of pixels wide, and half a pixel of line position is
    // millimetres of range at arm's length.
    const denom = profile[i - 1] - 2 * profile[i] + profile[i + 1];
    const delta = denom !== 0 ? (0.5 * (profile[i - 1] - profile[i + 1])) / denom : 0;
    const pos = i + Math.max(-1, Math.min(1, delta));
    const last = peaks[peaks.length - 1];
    if (last !== undefined && pos - last < minSeparation) {
      // Keep the stronger of two peaks that are too close to be separate boards.
      if (profile[i] > profile[Math.round(last)]) peaks[peaks.length - 1] = pos;
      continue;
    }
    peaks.push(pos);
  }
  return peaks;
}

/**
 * Fit an evenly-spaced lattice to a set of peaks.
 *
 * Exhaustive over the candidate spacings implied by the peaks themselves, which
 * is a few hundred hypotheses for a realistic frame — cheaper and far more
 * robust than an FFT, because a shelf gives you only a handful of periods and
 * the spectral peak is correspondingly broad.
 */
export function fitLattice(peaks: number[], minCells: number, maxCells: number, extent: number): Lattice | undefined {
  if (peaks.length < minCells + 1) return undefined;
  const tolerance = (s: number) => Math.max(1.5, 0.14 * s);
  let best: (Lattice & { score: number }) | undefined;

  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      const gap = peaks[j] - peaks[i];
      // The pair may straddle several openings; try each interpretation.
      for (let k = 1; k <= maxCells; k++) {
        const spacing = gap / k;
        if (spacing < 6 || spacing > extent) continue;
        const origin = peaks[i];
        const tol = tolerance(spacing);
        // Walk the lattice across the whole profile, then trim the unsupported
        // slots off both ends: a lattice is defined by the lines that are
        // actually there, not by how far the pattern could be continued into
        // empty wall. Extending to the frame edge was scoring a real 4-bay fit
        // worse than a spurious 2-bay one, because every off-object slot
        // counted as a missing line.
        const first = Math.ceil((0 - origin) / spacing - 0.001);
        const last = Math.floor((extent - origin) / spacing + 0.001);
        const slots: { pos: number; matched: boolean; error: number }[] = [];
        for (let n = first; n <= last; n++) {
          const expected = origin + n * spacing;
          let nearest: number | undefined;
          let bestD = tol;
          for (const p of peaks) {
            const d = Math.abs(p - expected);
            if (d < bestD) { bestD = d; nearest = p; }
          }
          slots.push(nearest !== undefined
            ? { pos: nearest, matched: true, error: bestD }
            : { pos: expected, matched: false, error: tol });
        }
        while (slots.length && !slots[0].matched) slots.shift();
        while (slots.length && !slots[slots.length - 1].matched) slots.pop();

        const cells = slots.length - 1;
        if (cells < minCells || cells > maxCells) continue;
        const inliers = slots.filter((sl) => sl.matched).length;
        const residual = slots.reduce((acc, sl) => acc + (sl.matched ? sl.error : 0), 0);
        const coverage = inliers / slots.length;
        // Missing lines are penalised twice as hard as extra openings are
        // rewarded, so a sparse "lattice" never outscores a dense real one.
        const score = inliers - 2 * (slots.length - inliers) - residual / tol;
        if (coverage < 0.75) continue;
        if (!best || score > best.score) {
          best = { positions: slots.map((sl) => sl.pos), spacing, coverage, score };
        }
      }
    }
  }
  if (!best) return undefined;
  return { positions: best.positions, spacing: best.spacing, coverage: best.coverage };
}

/**
 * Find a grid facade in a camera frame. Returns undefined when the frame does
 * not contain a convincing lattice — which is most frames, and is the point:
 * this must stay quiet rather than anchoring the overlay to a bookshelf-shaped
 * pattern in the carpet.
 */
export function detectGridFacade(image: ImageData, opts: GridDetectOptions = {}): GridObservation | undefined {
  const workingSize = opts.workingSize ?? 240;
  const minCells = opts.minCells ?? 2;
  const maxCells = opts.maxCells ?? 8;
  if (image.width < 16 || image.height < 16) return undefined;

  const { g, w, h, scale } = grayscale(image, workingSize);
  const { cols, rows } = edgeProfiles(g, w, h);

  const xPeaks = findPeaks(cols, opts.peakSigma ?? 0.8);
  const yPeaks = findPeaks(rows, opts.peakSigma ?? 0.8);
  const xFit = fitLattice(xPeaks, minCells, maxCells, w - 1);
  const yFit = fitLattice(yPeaks, minCells, maxCells, h - 1);
  if (!xFit || !yFit) return undefined;

  const xLines = xFit.positions.map((p) => p * scale);
  const yLines = yFit.positions.map((p) => p * scale);
  const x0 = xLines[0];
  const x1 = xLines[xLines.length - 1];
  const y0 = yLines[0];
  const y1 = yLines[yLines.length - 1];

  return {
    quad: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    cols: xLines.length - 1,
    rows: yLines.length - 1,
    xLines,
    yLines,
    confidence: Math.min(xFit.coverage, yFit.coverage),
  };
}

/**
 * Does an observation match the grid the loaded assembly declares?
 *
 * The bay count must be exact — that is the identity check, and it is what
 * stops a 3x3 shelf from being mistaken for the 4x4 one — and the observed
 * aspect ratio must agree with the physical one, which rejects a lattice seen
 * from an angle too oblique for the axis-aligned fit to be trusted.
 */
export function matchesGridTarget(
  obs: GridObservation,
  target: { cols: number; rows: number; widthM: number; heightM: number },
  aspectTolerance = 0.25,
): boolean {
  if (obs.cols !== target.cols || obs.rows !== target.rows) return false;
  const observed = (obs.quad[1].x - obs.quad[0].x) / (obs.quad[2].y - obs.quad[1].y);
  const expected = target.widthM / target.heightM;
  if (!Number.isFinite(observed) || observed <= 0) return false;
  return Math.abs(observed - expected) / expected <= aspectTolerance;
}
