import { describe, expect, it } from 'vitest';
import { CHANNELS, CONTEXT, cropToRgba, INPUT_SIZE, insideConvex, presenceCrop } from './presenceInput';

/** A frame that is red left of x = 50 and blue from there, 100 × 80. */
function halves(): ImageData {
  const width = 100; const height = 80;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = x < 50 ? 255 : 0; data[o + 2] = x < 50 ? 0 : 255; data[o + 3] = 255;
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
}

const plane = INPUT_SIZE * INPUT_SIZE;
const at = (c: Float32Array, ch: number, i: number, j: number) => c[ch * plane + j * INPUT_SIZE + i];

describe('the presence model\'s input', () => {
  it('tells inside from outside a convex outline, either way round', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(insideConvex(square, 5, 5)).toBe(true);
    expect(insideConvex([...square].reverse(), 5, 5)).toBe(true);
    expect(insideConvex(square, 11, 5)).toBe(false);
  });

  it('is a square around the outline with context on every side, the outline filled in', () => {
    // An outline 20 px square centred on the colour boundary.
    const hull = [{ x: 40, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 50 }, { x: 40, y: 50 }];
    const crop = presenceCrop(halves(), hull)!;
    expect(crop.data).toHaveLength(CHANNELS * plane);
    expect(crop.rect.size).toBeCloseTo(20 * (1 + 2 * CONTEXT));
    expect(crop.rect.x).toBeCloseTo(50 - crop.rect.size / 2);
    // Centre of the input is in the outline; a corner is context, outside it.
    expect(at(crop.data, 3, 48, 48)).toBe(1);
    expect(at(crop.data, 3, 2, 2)).toBe(0);
    // Left of centre is red, right is blue: the frame is not mirrored or swapped.
    expect(at(crop.data, 0, 10, 48)).toBeCloseTo(1);
    expect(at(crop.data, 2, 10, 48)).toBeCloseTo(0);
    expect(at(crop.data, 2, 85, 48)).toBeCloseTo(1);
    expect(crop.inFrame).toBe(1);
  });

  it('is black past the edge of the frame, and says how much of it was', () => {
    const hull = [{ x: -10, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 50 }, { x: -10, y: 50 }];
    const crop = presenceCrop(halves(), hull)!;
    expect(at(crop.data, 0, 2, 48)).toBe(0);
    expect(crop.inFrame).toBeGreaterThan(0.3);
    expect(crop.inFrame).toBeLessThan(0.7);
  });

  it('declines an outline with no extent', () => {
    expect(presenceCrop(halves(), [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }])).toBeUndefined();
    expect(presenceCrop(halves(), [{ x: 1, y: 1 }, { x: 2, y: 2 }])).toBeUndefined();
  });

  it('stores the outline in alpha for the training set', () => {
    const hull = [{ x: 40, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 50 }, { x: 40, y: 50 }];
    const rgba = cropToRgba(presenceCrop(halves(), hull)!);
    const centre = (48 * INPUT_SIZE + 48) * 4;
    expect(rgba[centre + 3]).toBe(255);
    expect(rgba[3]).toBe(0);
  });
});
