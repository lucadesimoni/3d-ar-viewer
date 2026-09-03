import { describe, expect, it } from 'vitest';
import { iou, nonMaxSuppression, resizeTo, type Detection } from './onnx';
import { crop, measureSharpness } from './opencv';
import { checkExpectation } from './pipeline';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const det = (label: string, score: number, b = box(0, 0, 0.2, 0.2)): Detection => ({
  label, classId: label.charCodeAt(0), score, box: b,
});

describe('iou', () => {
  it('is 1 for identical boxes and 0 for disjoint', () => {
    expect(iou(box(0, 0, 1, 1), box(0, 0, 1, 1))).toBeCloseTo(1);
    expect(iou(box(0, 0, 1, 1), box(2, 2, 1, 1))).toBe(0);
  });
  it('computes partial overlap', () => {
    // Two unit boxes offset by 0.5 on x: intersection 0.5, union 1.5.
    expect(iou(box(0, 0, 1, 1), box(0.5, 0, 1, 1))).toBeCloseTo(0.5 / 1.5, 5);
  });
});

describe('nonMaxSuppression', () => {
  it('drops a lower-scoring overlapping box of the same class', () => {
    const kept = nonMaxSuppression(
      [det('a', 0.9, box(0, 0, 0.3, 0.3)), det('a', 0.6, box(0.02, 0.02, 0.3, 0.3))],
      0.4,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(0.9);
  });
  it('keeps overlapping boxes of different classes', () => {
    const kept = nonMaxSuppression(
      [det('a', 0.9, box(0, 0, 0.3, 0.3)), det('b', 0.8, box(0, 0, 0.3, 0.3))],
      0.4,
    );
    expect(kept).toHaveLength(2);
  });
});

describe('resizeTo / crop', () => {
  const img = (w: number, h: number): ImageData => {
    const d = new Uint8ClampedArray(w * h * 4).fill(200);
    return { data: d, width: w, height: h, colorSpace: 'srgb' } as ImageData;
  };

  it('resizes to the requested dimensions', () => {
    const out = resizeTo(img(8, 8), 4, 4);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
  });

  it('crops a clamped region', () => {
    const out = crop(img(10, 10), -2, -2, 6, 6);
    expect(out.width).toBeLessThanOrEqual(6);
    expect(out.height).toBeLessThanOrEqual(6);
  });
});

describe('measureSharpness (JS fallback)', () => {
  it('rates a flat frame as blurred and a noisy frame as sharp', () => {
    const flat = new Uint8ClampedArray(32 * 32 * 4).fill(128);
    const flatImg = { data: flat, width: 32, height: 32, colorSpace: 'srgb' } as ImageData;
    expect(measureSharpness(flatImg, 50).sharp).toBe(false);

    const noisy = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      const v = (i * 97) % 2 === 0 ? 0 : 255;
      noisy[i * 4] = noisy[i * 4 + 1] = noisy[i * 4 + 2] = v;
      noisy[i * 4 + 3] = 255;
    }
    const noisyImg = { data: noisy, width: 32, height: 32, colorSpace: 'srgb' } as ImageData;
    expect(measureSharpness(noisyImg, 50).variance).toBeGreaterThan(50);
  });
});

describe('checkExpectation', () => {
  it('confirms the expected part when detected', () => {
    const r = checkExpectation([det('cap-left', 0.8)], 'cap-left');
    expect(r.seen).toBe(true);
    expect(r.wrongPartLabel).toBeUndefined();
  });
  it('flags a confidently-seen wrong part', () => {
    const r = checkExpectation([det('cap-right', 0.85)], 'cap-left');
    expect(r.seen).toBe(false);
    expect(r.wrongPartLabel).toBe('cap-right');
  });
  it('ignores weak detections below the score floor', () => {
    const r = checkExpectation([det('cap-right', 0.2)], 'cap-left', 0.4);
    expect(r.wrongPartLabel).toBeUndefined();
  });
});
