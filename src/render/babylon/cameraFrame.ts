import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';

/**
 * The camera image, out of an XR session and into the bit that looks at it.
 *
 * Until now the whole vision path was switched off inside a session — one
 * clause in `useArController`'s loop, `|| xrSession.current`, and on Android
 * the app never looked at its own camera in the mode the operator actually
 * uses. The frames were there the entire time: `camera-access` is granted, and
 * `xr.ts` already held a `WebXRRawCameraAccess` whose comment said, in as many
 * words, "the frames part inspection needs". Only the intrinsics were taken.
 * `texturesData` was left on the floor.
 *
 * Two things decide whether this is honest, and both are taken from the
 * renderer rather than assumed:
 *
 * **Which way up.** WebGL hands back framebuffer rows from the bottom; an
 * image counts them from the top; and Babylon records per texture which of
 * those two it stored (`InternalTexture.invertY`), because it is the one that
 * uploaded it. Babylon's own `CopyTools` reads that same flag when it turns a
 * texture into a PNG. Guessing here would look, on the device, exactly like a
 * detector that cannot find a part that is in plain view — a failure this repo
 * has already paid for once in `cvPoseToRenderer`.
 *
 * **How big.** The full frame is 886x1920 on the device that reported
 * intrinsics: 6.8 MB per readback. It is reduced to the same working width the
 * video path uses, and both halves of the cost — pulling the pixels off the
 * GPU, and the scaling — are timed separately and go into the diagnostics
 * report. If the readback turns out to dominate, the next step is a GPU-side
 * resize; that decision wants a number from a real device, not a guess from
 * here.
 */

export interface CameraFrame {
  image: ImageData;
  /** Milliseconds spent pulling the pixels off the GPU. */
  readbackMs: number;
  /** Milliseconds spent scaling them down to the working size. */
  scaleMs: number;
  /** Full size of the camera texture, before scaling. */
  sourceSize: [number, number];
}

/**
 * Scale an RGBA buffer down to `maxWidth`, righting it if it arrived upside
 * down.
 *
 * A box average rather than nearest-neighbour: 886 to 480 is a factor of 1.85,
 * and dropping every other row of a shelf full of straight edges is how a
 * lattice fit starts seeing spacings that are not there.
 *
 * Alpha is forced opaque. The camera image has no transparency, and a texture
 * that reports some — an unwritten alpha channel reading zero — would otherwise
 * make every later `putImageData` invisible.
 *
 * The shape of this loop is the answer to a measurement, not to taste. A device
 * log reported `readbackMs 15.9, scaleMs 30.1` — the scaling costing twice what
 * pulling the pixels off the GPU did, which is the opposite of what I expected
 * when I wrote it. Two things came out of chasing that, on a 886x1920 frame:
 *
 * - **Nothing to average is not a special case, it is the common one.** A
 *   capture asks for 960 from an 886-wide frame, so every "box" was one pixel
 *   and the filter did 1.7 million single-element averages for no effect:
 *   122 ms, against 8 ms for the row copy it should have been.
 * - **The column bounds are the same on every row.** Computing them per pixel
 *   spent two divisions and two floors half a million times: 30.7 ms to 26.8.
 *
 * A separable two-pass version — narrow each source row, then average the
 * bands — was also tried, and was *worse*: 52 ms, because the intermediate is
 * 2.8 million floats and paying for that memory costs more than the arithmetic
 * it saves. Measured, discarded, and written down so it is not tried twice.
 */
export function toFrameImage(
  pixels: Uint8Array | Uint8ClampedArray,
  source: { width: number; height: number },
  maxWidth: number,
  invertY: boolean,
): ImageData | undefined {
  const { width: sw, height: sh } = source;
  if (sw < 1 || sh < 1 || maxWidth < 1) return undefined;
  if (pixels.length < sw * sh * 4) return undefined;

  const scale = Math.min(1, maxWidth / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const rowBytes = w * 4;

  // Full size: there is nothing to average, only rows to put the right way up.
  if (w === sw && h === sh) {
    for (let y = 0; y < h; y++) {
      const src = y * rowBytes;
      out.set(pixels.subarray(src, src + rowBytes), (invertY ? h - 1 - y : y) * rowBytes);
    }
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return new ImageData(out, w, h);
  }

  // Hoisted out of the pixel loop: every row's columns fall the same way.
  const x0s = new Int32Array(w);
  const x1s = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    const a = Math.floor((x * sw) / w);
    x0s[x] = a;
    x1s[x] = Math.max(a + 1, Math.floor(((x + 1) * sw) / w));
  }

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * sh) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / h));
    // Flipping the destination row is the same as mirroring the source box,
    // and it keeps the averaging window contiguous in the source.
    let d = (invertY ? h - 1 - y : y) * rowBytes;
    for (let x = 0; x < w; x++, d += 4) {
      const x0 = x0s[x];
      const x1 = x1s[x];
      const n = (x1 - x0) * (y1 - y0);
      let r = 0; let g = 0; let b = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * sw + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
        }
      }
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = 255;
    }
  }
  return new ImageData(out, w, h);
}

/**
 * One readback buffer for the life of the page.
 *
 * Nearly seven megabytes per frame, once a second, would otherwise be seven
 * megabytes of garbage per frame — and on a tablet that shows up as heat before
 * it shows up as frame rate, the same way the per-frame canvas did in
 * `toImageData`.
 */
let scratch: Uint8Array | undefined;

function buffer(bytes: number): Uint8Array {
  if (!scratch || scratch.length < bytes) scratch = new Uint8Array(bytes);
  return scratch.length === bytes ? scratch : scratch.subarray(0, bytes);
}

/** The camera texture as an image the vision path can read, or nothing. */
export async function readCameraFrame(
  texture: BaseTexture | undefined,
  maxWidth: number,
): Promise<CameraFrame | undefined> {
  if (!texture) return undefined;
  const { width, height } = texture.getSize();
  if (width < 1 || height < 1) return undefined;

  const startedAt = performance.now();
  let pixels: ArrayBufferView | null;
  try {
    pixels = await texture.readPixels(0, 0, buffer(width * height * 4), true, false);
  } catch {
    // A texture disposed mid-read — the session ended while this was in
    // flight. Not an error worth a log line every second.
    return undefined;
  }
  if (!pixels) return undefined;
  const readbackMs = performance.now() - startedAt;

  const scaledAt = performance.now();
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  // The renderer's own record of which way it stored the rows, not a guess.
  const invertY = texture.getInternalTexture()?.invertY ?? false;
  const image = toFrameImage(bytes, { width, height }, maxWidth, invertY);
  if (!image) return undefined;

  return {
    image,
    readbackMs,
    scaleMs: performance.now() - scaledAt,
    sourceSize: [width, height],
  };
}
