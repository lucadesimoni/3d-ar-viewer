import { describe, expect, it } from 'vitest';
import { bilinearResize, letterbox, unletterboxBox } from './preprocess';

function gradient(w: number, h: number): ImageData {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    d[i] = (x / w) * 255; d[i + 1] = (y / h) * 255; d[i + 2] = 128; d[i + 3] = 255;
  }
  return new ImageData(d, w, h);
}

describe('bilinearResize', () => {
  it('resizes to the requested size and interpolates smoothly', () => {
    const out = bilinearResize(gradient(16, 16), 8, 8);
    expect(out.width).toBe(8);
    expect(out.height).toBe(8);
    // Monotonic red gradient is preserved left-to-right.
    const row = 4 * 8 * 4;
    expect(out.data[row]).toBeLessThan(out.data[row + 7 * 4]);
  });
});

describe('letterbox', () => {
  it('preserves aspect ratio and pads to a square', () => {
    const lb = letterbox(gradient(160, 90), 64);
    expect(lb.image.width).toBe(64);
    expect(lb.image.height).toBe(64);
    // 16:9 into 64 => scaled height 36, so ~14px pad top and bottom.
    expect(lb.padY).toBeGreaterThan(10);
    expect(lb.padX).toBe(0);
    expect(lb.scale).toBeCloseTo(64 / 160, 5);
  });

  it('round-trips a box back to original-frame coordinates', () => {
    const srcW = 160, srcH = 90;
    const lb = letterbox(gradient(srcW, srcH), 64);
    // A box covering the middle of the ORIGINAL frame, forward-mapped by hand:
    const orig = { x: 0.25, y: 0.4, w: 0.5, h: 0.2 };
    // Forward map into the letterboxed square...
    const sq = {
      x: (orig.x * srcW * lb.scale + lb.padX) / lb.size,
      y: (orig.y * srcH * lb.scale + lb.padY) / lb.size,
      w: (orig.w * srcW * lb.scale) / lb.size,
      h: (orig.h * srcH * lb.scale) / lb.size,
    };
    // ...then un-letterbox should recover the original.
    const back = unletterboxBox(sq, lb);
    expect(back.x).toBeCloseTo(orig.x, 4);
    expect(back.y).toBeCloseTo(orig.y, 4);
    expect(back.w).toBeCloseTo(orig.w, 4);
    expect(back.h).toBeCloseTo(orig.h, 4);
  });
});
