/**
 * Synthetic camera frames of a cube shelf — test scaffolding, never bundled.
 *
 * Rendering the exact thing the detector claims to recognise is the only way to
 * test it without a phone pointed at real furniture, and because the geometry is
 * exact the assertions can be about pixels and millimetres rather than vibes.
 */

export interface ShelfView {
  width: number;
  height: number;
  /** Outer rectangle of the facade in the frame. */
  left: number;
  top: number;
  span: number;
  cols?: number;
  rows?: number;
  /** Board thickness as drawn; defaults to the KALLAX ratio, 30/1470. */
  boardRatio?: number;
  /** Amplitude of a deterministic dither, to stand in for sensor noise. */
  noise?: number;
  /** Overall brightness multiplier, to stand in for auto-exposure moving. */
  exposure?: number;
}

export function renderShelf(v: ShelfView): ImageData {
  const { width: w, height: h, left, top, span } = v;
  const cols = v.cols ?? 4;
  const rows = v.rows ?? 4;
  const boardPx = span * (v.boardRatio ?? 30 / 1470);
  const exposure = v.exposure ?? 1;
  const data = new Uint8ClampedArray(w * h * 4);

  const put = (x: number, y: number, value: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    const v8 = Math.max(0, Math.min(255, value * exposure));
    data[i] = data[i + 1] = data[i + 2] = v8;
    data[i + 3] = 255;
  };

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, 138);   // wall
  const spanY = (span / cols) * rows;
  for (let y = Math.round(top); y < Math.round(top + spanY); y++) {
    for (let x = Math.round(left); x < Math.round(left + span); x++) put(x, y, 235);  // boards
  }
  const pitchX = (span - boardPx) / cols;
  const pitchY = (spanY - boardPx) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round(left + boardPx + c * pitchX);
      const y0 = Math.round(top + boardPx + r * pitchY);
      for (let y = y0; y < Math.round(y0 + pitchY - boardPx); y++) {
        for (let x = x0; x < Math.round(x0 + pitchX - boardPx); x++) put(x, y, 42);  // openings
      }
    }
  }

  if (v.noise) {
    for (let i = 0; i < data.length; i += 4) {
      const n = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * v.noise;
      data[i] += n; data[i + 1] += n; data[i + 2] += n;
    }
  }
  return new ImageData(data, w, h);
}
