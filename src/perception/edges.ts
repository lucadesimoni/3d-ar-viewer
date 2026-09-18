import { toGray, type GrayImage } from '../vision/imageOps';

/**
 * Is there a real edge where the geometry says there should be one?
 *
 * This is the measurement the whole presence question rests on. The overlay
 * already knows, from the anchor and the part's box, where each silhouette edge
 * ought to land in the image. Asking whether the image agrees there — rather
 * than trying to discover the object bottom-up — is the difference between a
 * check and a guess.
 *
 * Bottom-up is what `vision/gridRecognition` does, and a device log showed its
 * limit: two instrument cases standing on a real KALLAX put a strong horizontal
 * edge about one cube pitch above the top board, the periodicity search took it
 * for a fourth board line, and the shelf read as three rows instead of two. The
 * obvious cheap defence — score each candidate line by how much of the facade's
 * width supports it, since a real board runs edge to edge and a suitcase does
 * not — was tried against those frames and **measured to be wrong**: the cases
 * are dark against a light wall and score 0.77, while the real bottom board is
 * white against a pale oak floor and scores 0.60. Edge strength separates
 * materials and lighting, not structure from clutter. Written down so it is not
 * tried a second time.
 *
 * What survives that finding is this: do not ask "what structure is in this
 * image", ask "does the image agree with the structure I already believe in".
 * A pose that put the bottom board in the floor is then refuted by the floor
 * having no edge where the board's bottom would be — which is a question with
 * an answer, at one known place, rather than a search.
 *
 * Sharpness is deliberately not here. `measureSharpness` in `vision/opencv.ts`
 * already does variance-of-Laplacian and already degrades to a dependency-free
 * JS path when OpenCV has not loaded, so `eligibility` calls that rather than
 * this module growing a second copy of it.
 */

export interface EdgeField {
  /** The working-resolution grey image the gradients were taken from. */
  gray: GrayImage;
  /** Gradient magnitude per working-resolution pixel. */
  magnitude: Float32Array;
  /**
   * What a gradient must beat to count as an edge at all.
   *
   * Mean plus `k` standard deviations of this frame's own gradients — the same
   * shape of rule as `findPeaks` in `gridRecognition`, and local to the frame
   * for the same reason: a dim room and a bright one have different gradients
   * everywhere, and a fixed number would mean "present" in one and "absent" in
   * the other.
   */
  floor: number;
}

/**
 * Gradient magnitudes and this frame's noise floor, computed once.
 *
 * Split from the per-point search because a part has tens of support points and
 * a frame has one gradient field; doing this per point would multiply the one
 * expensive pass by the number of questions asked of it. At 1 Hz on a tablet
 * that is the difference between affordable and not.
 */
export function edgeField(image: ImageData, workingSize = 240, k = 1): EdgeField {
  const gray = toGray(image, workingSize);
  const { data: g, width: w, height: h } = gray;
  const magnitude = new Float32Array(w * h);

  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i + 1] - g[i - 1];
      const gy = g[i + w] - g[i - w];
      const m = Math.hypot(gx, gy);
      magnitude[i] = m;
      sum += m;
      n++;
    }
  }
  if (n === 0) return { gray, magnitude, floor: Infinity };

  const mean = sum / n;
  let varSum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) varSum += (magnitude[y * w + x] - mean) ** 2;
  }
  return { gray, magnitude, floor: mean + k * Math.sqrt(varSum / n) };
}

/** Bilinear sample of the magnitude field, in working-resolution pixels. */
function sampleMagnitude(field: EdgeField, x: number, y: number): number {
  const { magnitude, gray } = field;
  const { width: w, height: h } = gray;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = magnitude[y0 * w + x0] * (1 - fx) + magnitude[y0 * w + x1] * fx;
  const b = magnitude[y1 * w + x0] * (1 - fx) + magnitude[y1 * w + x1] * fx;
  return a * (1 - fy) + b * fy;
}

export interface EdgeHit {
  /**
   * Where the edge actually was, relative to where it was expected, in
   * full-resolution image pixels along the given normal. Signed: positive means
   * the edge sits further along the normal than the geometry predicted.
   *
   * This is the snap signal. A part that is present but whose anchor is out by
   * two centimetres gives a consistent non-zero offset at every support point;
   * noise gives offsets that cancel.
   */
  offsetPx: number;
  /** Gradient magnitude at the edge found. */
  strength: number;
}

/**
 * Look for an edge along a line through `(u, v)`, in full-resolution pixels.
 *
 * A 1-D search rather than a 2-D one because the direction is not in doubt: the
 * geometry says which way the silhouette runs, so the only open question is how
 * far along its own normal the edge really sits. Searching a strip instead of a
 * disc keeps a neighbouring part's edge from answering for this one.
 *
 * `searchPx` bounds how wrong the anchor is allowed to be and still be
 * correctable — beyond it the answer is "not here", which is the honest one:
 * an edge found 40 px away is more likely another object than this one
 * mis-placed.
 */
export function findEdgeAlongNormal(
  field: EdgeField,
  u: number,
  v: number,
  nu: number,
  nv: number,
  searchPx = 12,
): EdgeHit | undefined {
  const len = Math.hypot(nu, nv);
  if (len === 0 || !Number.isFinite(len)) return undefined;
  const dx = nu / len;
  const dy = nv / len;

  const { scale } = field.gray;
  // Half a working pixel per step: finer than the image can resolve is wasted
  // work, coarser walks past the peak it is looking for.
  const stepPx = scale / 2;
  const steps = Math.floor(searchPx / stepPx);

  let bestT = 0;
  let best = -1;
  const at = (t: number): number =>
    sampleMagnitude(field, (u + dx * t) / scale, (v + dy * t) / scale);

  for (let s = -steps; s <= steps; s++) {
    const t = s * stepPx;
    const m = at(t);
    if (m > best) { best = m; bestT = t; }
  }
  // Both guards are needed. A uniform frame has no gradients at all, so its
  // mean and deviation are zero and so is the floor — and "at least as strong
  // as zero" is true of nothing at all, which would report an edge of strength
  // zero on a blank wall. An empty image proves nothing; say so.
  if (best <= 0 || best < field.floor) return undefined;

  // Parabola through the peak and its neighbours: the field is sampled every
  // half working pixel, which is four full-resolution pixels at the usual
  // scale, and the offset is a distance the snap correction is read from.
  const prev = at(bestT - stepPx);
  const next = at(bestT + stepPx);
  const denom = prev - 2 * best + next;
  const shift = denom !== 0 ? (0.5 * (prev - next)) / denom : 0;
  const refined = bestT + Math.max(-1, Math.min(1, shift)) * stepPx;

  return { offsetPx: refined, strength: best };
}
