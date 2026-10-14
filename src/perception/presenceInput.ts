import type { Point2 } from './agreement';

/**
 * What the presence model is shown: one part's patch of the camera frame, and
 * where in that patch the part should be.
 *
 * The model answers a single question, "is this part in place?", for any part
 * of any assembly, because it is not told which part it is looking at. It is
 * told where the part's outline should fall (the fourth channel, the projected
 * hull filled in) and judges whether the picture has a part there. A
 * part-specific classifier would need training images of every part of every
 * product. This one is trained once, on synthetic renders
 * (`scripts/presence/`).
 *
 * The training data is cut by this same function in the same browser, so what
 * the model learned from and what it is shown in the field are the same thing,
 * pixel for pixel. A second implementation in the training code would be a
 * second opinion about cropping, and the place a train/serve skew would hide.
 */

/** The model's input is INPUT_SIZE × INPUT_SIZE. */
export const INPUT_SIZE = 96;
/** Context around the outline's bounding box, as a share of its larger side, on each side. */
export const CONTEXT = 0.25;
/** Channels: red, green, blue (0..1) and the expected outline (0 or 1). */
export const CHANNELS = 4;

export interface PresenceCrop {
  /** The square of the frame that was sampled, in image pixels; it may reach past the edges. */
  rect: { x: number; y: number; size: number };
  /** CHANNELS × INPUT_SIZE × INPUT_SIZE, channel-major. */
  data: Float32Array;
  /** Share of the square that lies inside the frame. */
  inFrame: number;
}

/** Whether `p` is inside the convex polygon `hull` (either winding). */
export function insideConvex(hull: readonly Point2[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * The model input for a part whose outline in `image` is `hull`.
 *
 * Bilinear sampling, because a crop is usually two to four times larger than
 * the input and nearest-neighbour shrinking turns a board's edge into a
 * staircase that a synthetic render would not have. Outside the frame is
 * black, with no outline.
 */
export function presenceCrop(image: ImageData, hull: readonly Point2[]): PresenceCrop | undefined {
  if (hull.length < 3) return undefined;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of hull) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const side = Math.max(maxX - minX, maxY - minY);
  if (!(side > 1) || !Number.isFinite(side)) return undefined;
  const size = side * (1 + 2 * CONTEXT);
  const x0 = (minX + maxX) / 2 - size / 2;
  const y0 = (minY + maxY) / 2 - size / 2;
  const step = size / INPUT_SIZE;
  const { width, height, data: px } = image;
  const plane = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(CHANNELS * plane);
  let inside = 0;

  for (let j = 0; j < INPUT_SIZE; j++) {
    const y = y0 + (j + 0.5) * step;
    for (let i = 0; i < INPUT_SIZE; i++) {
      const x = x0 + (i + 0.5) * step;
      const o = j * INPUT_SIZE + i;
      if (insideConvex(hull, x, y)) out[3 * plane + o] = 1;
      // Pixel centres sit at +0.5.
      const fx = x - 0.5;
      const fy = y - 0.5;
      if (fx < 0 || fy < 0 || fx > width - 1 || fy > height - 1) continue;
      inside++;
      const xa = Math.floor(fx); const ya = Math.floor(fy);
      const xb = Math.min(xa + 1, width - 1); const yb = Math.min(ya + 1, height - 1);
      const tx = fx - xa; const ty = fy - ya;
      const a = (ya * width + xa) * 4; const b = (ya * width + xb) * 4;
      const c = (yb * width + xa) * 4; const d = (yb * width + xb) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = px[a + ch] + (px[b + ch] - px[a + ch]) * tx;
        const bottom = px[c + ch] + (px[d + ch] - px[c + ch]) * tx;
        out[ch * plane + o] = (top + (bottom - top) * ty) / 255;
      }
    }
  }
  return { rect: { x: x0, y: y0, size }, data: out, inFrame: inside / plane };
}

/** The crop as RGBA bytes, the outline in alpha: how the training set stores it. */
export function cropToRgba(crop: PresenceCrop): Uint8ClampedArray {
  const plane = INPUT_SIZE * INPUT_SIZE;
  const out = new Uint8ClampedArray(plane * 4);
  for (let o = 0; o < plane; o++) {
    out[o * 4] = Math.round(crop.data[o] * 255);
    out[o * 4 + 1] = Math.round(crop.data[plane + o] * 255);
    out[o * 4 + 2] = Math.round(crop.data[2 * plane + o] * 255);
    out[o * 4 + 3] = crop.data[3 * plane + o] > 0.5 ? 255 : 0;
  }
  return out;
}
