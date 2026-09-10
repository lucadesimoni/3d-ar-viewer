import { describe, expect, it } from 'vitest';
import { clampRoi, toFullFrame } from './pipeline';

const image = { width: 480, height: 640 };

describe('what a detection inside a cutout means for the whole frame', () => {
  it('puts the middle of a bottom-right cutout at the bottom right', () => {
    // The trap in the seam: a model's box is normalised against whatever frame
    // it was shown, and `process` used to hand back the cutout's numbers as if
    // they were the picture's. They stay in 0..1 and simply mean somewhere
    // else — a detection reported at the centre of the image while the part is
    // in the corner, and a tracker matching boxes across a rectangle that moves.
    const region = clampRoi(image, { x: 240, y: 320, w: 240, h: 320 });
    const full = toFullFrame({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, region, image);
    expect(full.x).toBeCloseTo(0.75, 6);
    expect(full.y).toBeCloseTo(0.75, 6);
    expect(full.w).toBeCloseTo(0.1, 6);
    expect(full.h).toBeCloseTo(0.1, 6);
  });

  it('changes nothing when the cutout is the whole frame', () => {
    const region = clampRoi(image, { x: 0, y: 0, w: 480, h: 640 });
    const box = { x: 0.3, y: 0.7, w: 0.25, h: 0.1 };
    const full = toFullFrame(box, region, image);
    expect(full).toEqual(box);
  });

  it('maps through the rectangle that was taken, not the one that was asked for', () => {
    // `crop` clamps and floors. Mapping back through the request instead of the
    // result is a few pixels out at every edge — and the edge of the frame is
    // exactly where a half-visible part makes the answer hardest already.
    const asked = { x: -40, y: 600, w: 200, h: 200 };
    const region = clampRoi(image, asked);
    expect(region).toEqual({ x: 0, y: 600, w: 160, h: 40 });
    const full = toFullFrame({ x: 0, y: 0, w: 1, h: 1 }, region, image);
    expect(full.x).toBe(0);
    expect(full.y).toBeCloseTo(600 / 640, 6);
    expect(full.w).toBeCloseTo(160 / 480, 6);
    expect(full.h).toBeCloseTo(40 / 640, 6);
  });

  it('never produces an empty cutout, however far outside the frame it is asked', () => {
    for (const asked of [
      { x: 10_000, y: 10_000, w: 10, h: 10 },
      { x: -500, y: -500, w: 10, h: 10 },
      { x: 100, y: 100, w: 0, h: 0 },
    ]) {
      const region = clampRoi(image, asked);
      expect(region.w).toBeGreaterThan(0);
      expect(region.h).toBeGreaterThan(0);
    }
  });
});
