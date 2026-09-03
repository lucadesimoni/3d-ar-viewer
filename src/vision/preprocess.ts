/**
 * Frame preprocessing for the neural nets.
 *
 * Two things here materially improve recognition accuracy over a naive resize:
 *
 *  - **Bilinear** resampling instead of nearest-neighbour. A tablet frame is
 *    high resolution and the model input is small (often 320–640 px); dropping
 *    to nearest-neighbour throws away most of the signal and adds aliasing that
 *    a detector reads as spurious edges.
 *  - **Letterboxing** instead of an anisotropic squash. Squashing a 16:9 frame
 *    into a square stretches every part's aspect ratio, so a model trained on
 *    correctly-proportioned images sees shapes it was never shown. Letterboxing
 *    preserves aspect and pads the remainder, then boxes are un-mapped back to
 *    the original frame afterwards.
 */

export interface LetterboxResult {
  image: ImageData;
  /** Uniform scale applied to the source before padding. */
  scale: number;
  /** Padding added on the left and top, in output pixels. */
  padX: number;
  padY: number;
  /** Output side length (square). */
  size: number;
  srcWidth: number;
  srcHeight: number;
}

/** Bilinear resize into a fresh ImageData of the requested size. */
export function bilinearResize(image: ImageData, outW: number, outH: number): ImageData {
  const { data, width, height } = image;
  if (width === outW && height === outH) return image;
  const out = new Uint8ClampedArray(outW * outH * 4);
  // Map output pixel centres back into source space.
  const sx = width / outW;
  const sy = height / outH;

  for (let y = 0; y < outH; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.floor(fy);
    const wy = fy - y0;
    const y0c = Math.min(height - 1, Math.max(0, y0));
    const y1c = Math.min(height - 1, y0 + 1);
    for (let x = 0; x < outW; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = Math.floor(fx);
      const wx = fx - x0;
      const x0c = Math.min(width - 1, Math.max(0, x0));
      const x1c = Math.min(width - 1, x0 + 1);

      const i00 = (y0c * width + x0c) * 4;
      const i01 = (y0c * width + x1c) * 4;
      const i10 = (y1c * width + x0c) * 4;
      const i11 = (y1c * width + x1c) * 4;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[i00 + c] * (1 - wx) + data[i01 + c] * wx;
        const bot = data[i10 + c] * (1 - wx) + data[i11 + c] * wx;
        out[o + c] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return new ImageData(out, outW, outH);
}

/**
 * Resize `image` to fit a `size`×`size` square while preserving aspect ratio,
 * padding the remainder with a neutral grey (`pad`, default 114 — the value
 * ultralytics-style detectors are trained with).
 */
export function letterbox(image: ImageData, size: number, pad = 114): LetterboxResult {
  const scale = Math.min(size / image.width, size / image.height);
  const newW = Math.round(image.width * scale);
  const newH = Math.round(image.height * scale);
  const resized = bilinearResize(image, newW, newH);

  const out = new Uint8ClampedArray(size * size * 4);
  out.fill(pad);
  // Keep alpha opaque even in the padded border.
  for (let i = 3; i < out.length; i += 4) out[i] = 255;

  const padX = Math.floor((size - newW) / 2);
  const padY = Math.floor((size - newH) / 2);
  for (let y = 0; y < newH; y++) {
    const dst = ((y + padY) * size + padX) * 4;
    const src = y * newW * 4;
    out.set(resized.data.subarray(src, src + newW * 4), dst);
  }

  return { image: new ImageData(out, size, size), scale, padX, padY, size, srcWidth: image.width, srcHeight: image.height };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Undo a letterbox on a detection box.
 *
 * `box` is normalised (0..1) in the letterboxed square as the model emits it;
 * the result is normalised (0..1) in the *original* frame, so the overlay draws
 * it where the part actually is rather than shifted by the padding.
 */
export function unletterboxBox(box: Box, lb: LetterboxResult): Box {
  const px = box.x * lb.size;
  const py = box.y * lb.size;
  const pw = box.w * lb.size;
  const ph = box.h * lb.size;
  // Remove padding, undo scale, re-normalise against the source size.
  const ox = (px - lb.padX) / lb.scale;
  const oy = (py - lb.padY) / lb.scale;
  const ow = pw / lb.scale;
  const oh = ph / lb.scale;
  return {
    x: ox / lb.srcWidth,
    y: oy / lb.srcHeight,
    w: ow / lb.srcWidth,
    h: oh / lb.srcHeight,
  };
}
