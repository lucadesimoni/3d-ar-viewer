/**
 * The small amount of image processing the AR path needs every frame.
 *
 * Deliberately plain JavaScript over `ImageData`: it runs before OpenCV.js has
 * finished streaming in, it runs when the CDN is unreachable, and at these
 * sizes it is fast enough that pulling in WASM would cost more than it saves.
 * Everything here is written to be called at frame rate on a tablet.
 */

export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
  /** How many source pixels one pixel here covers, for mapping back. */
  scale: number;
}

/**
 * Luma of an RGBA frame, box-downsampled so the cost is bounded by
 * `workingSize` rather than by the camera's resolution.
 *
 * Box-averaging rather than nearest-neighbour matters: it is a low-pass filter,
 * so the edges that survive are real edges and not aliasing artefacts of a
 * fine repeating pattern — which is exactly what a shelf front is.
 */
export function toGray(image: ImageData, workingSize: number): GrayImage {
  const step = Math.max(1, Math.ceil(Math.max(image.width, image.height) / workingSize));
  const width = Math.floor(image.width / step);
  const height = Math.floor(image.height / step);
  const data = new Float32Array(width * height);
  const src = image.data;
  // (r + 2g + b) / 4 instead of the exact luma weights. This runs on every
  // camera frame over every pixel, and it is the hottest loop in the AR path;
  // the approximation is within a couple of levels of Rec. 601 and everything
  // downstream looks at gradients and correlations, which do not care.
  const inv = 1 / (4 * step * step);
  for (let y = 0; y < height; y++) {
    const out = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let sy = 0; sy < step; sy++) {
        const row = (y * step + sy) * image.width + x * step;
        for (let sx = 0; sx < step; sx++) {
          const i = (row + sx) * 4;
          sum += src[i] + 2 * src[i + 1] + src[i + 2];
        }
      }
      data[out + x] = sum * inv;
    }
  }
  return { data, width, height, scale: step };
}

/**
 * Halve a grey image with a 2x2 box filter.
 *
 * The coarse level of the tracking pyramid: matching there covers four times
 * the ground for the same search radius, which is what lets a point be found
 * again after a fast pan or a dropped frame.
 */
export function downsample2(img: GrayImage): GrayImage {
  const width = img.width >> 1;
  const height = img.height >> 1;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const r0 = (y * 2) * img.width;
    const r1 = (y * 2 + 1) * img.width;
    for (let x = 0; x < width; x++) {
      const c0 = x * 2;
      data[y * width + x] = (img.data[r0 + c0] + img.data[r0 + c0 + 1] + img.data[r1 + c0] + img.data[r1 + c0 + 1]) / 4;
    }
  }
  return { data, width, height, scale: img.scale * 2 };
}

export interface Patch {
  /** Zero-mean pixel values, row major. */
  values: Float32Array;
  radius: number;
  /** Euclidean norm of `values`; zero for a featureless patch. */
  norm: number;
}

/** Cut a zero-mean patch out of `img`, or undefined if it does not fit. */
export function samplePatch(img: GrayImage, cx: number, cy: number, radius: number): Patch | undefined {
  const x0 = Math.round(cx) - radius;
  const y0 = Math.round(cy) - radius;
  const size = radius * 2 + 1;
  if (x0 < 0 || y0 < 0 || x0 + size > img.width || y0 + size > img.height) return undefined;

  const values = new Float32Array(size * size);
  let mean = 0;
  for (let y = 0; y < size; y++) {
    const row = (y0 + y) * img.width + x0;
    for (let x = 0; x < size; x++) {
      const v = img.data[row + x];
      values[y * size + x] = v;
      mean += v;
    }
  }
  mean /= values.length;
  let norm = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] -= mean;
    norm += values[i] * values[i];
  }
  return { values, radius, norm: Math.sqrt(norm) };
}

export interface MatchResult {
  x: number;
  y: number;
  /** Normalised cross-correlation, -1..1. */
  score: number;
}

/**
 * Find where `patch` sits in `img`, searching a square window around a guess.
 *
 * Normalised cross-correlation rather than plain difference, because a phone
 * camera re-exposes constantly: the same board is a different brightness one
 * frame later, and an SSD tracker walks off the object the moment the auto
 * exposure moves. NCC only cares about the pattern.
 *
 * The result is refined to sub-pixel by fitting a parabola through the score
 * either side of the winner — without it the tracked pose jitters by a whole
 * pixel of range, which is centimetres at arm's length and very visible.
 */
export function matchPatch(
  img: GrayImage,
  patch: Patch,
  guessX: number,
  guessY: number,
  searchRadius: number,
): MatchResult | undefined {
  if (patch.norm < 1e-6) return undefined;      // featureless: nothing to match
  const size = patch.radius * 2 + 1;
  const cx = Math.round(guessX);
  const cy = Math.round(guessY);

  let best = -Infinity;
  let bestX = cx;
  let bestY = cy;
  const scores = new Float32Array((searchRadius * 2 + 1) * (searchRadius * 2 + 1));
  const stride = searchRadius * 2 + 1;

  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const x0 = cx + dx - patch.radius;
      const y0 = cy + dy - patch.radius;
      if (x0 < 0 || y0 < 0 || x0 + size > img.width || y0 + size > img.height) {
        scores[(dy + searchRadius) * stride + (dx + searchRadius)] = -1;
        continue;
      }
      let sum = 0;
      let sumSq = 0;
      let cross = 0;
      for (let y = 0; y < size; y++) {
        const row = (y0 + y) * img.width + x0;
        const prow = y * size;
        for (let x = 0; x < size; x++) {
          const v = img.data[row + x];
          sum += v;
          sumSq += v * v;
          cross += v * patch.values[prow + x];
        }
      }
      const n = size * size;
      const variance = sumSq - (sum * sum) / n;
      const score = variance > 1e-6 ? cross / (patch.norm * Math.sqrt(variance)) : -1;
      scores[(dy + searchRadius) * stride + (dx + searchRadius)] = score;
      if (score > best) { best = score; bestX = cx + dx; bestY = cy + dy; }
    }
  }
  if (!Number.isFinite(best) || best <= 0) return undefined;

  // Sub-pixel: parabola through the winner and its neighbours on each axis.
  const at = (dx: number, dy: number): number => {
    const ix = bestX - cx + dx + searchRadius;
    const iy = bestY - cy + dy + searchRadius;
    if (ix < 0 || iy < 0 || ix >= stride || iy >= stride) return -1;
    return scores[iy * stride + ix];
  };
  const refine = (a: number, b: number, c: number): number => {
    const denom = a - 2 * b + c;
    if (Math.abs(denom) < 1e-9) return 0;
    return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
  };
  const ox = refine(at(-1, 0), best, at(1, 0));
  const oy = refine(at(0, -1), best, at(0, 1));

  return { x: bestX + ox, y: bestY + oy, score: best };
}
