import { describe, expect, it } from 'vitest';
import { edgeField } from './edges';
import { quadAgreement, weakestSide } from './agreement';

const W = 240;
const H = 240;

/** A light rectangle on a dark ground — an outline to agree or disagree with. */
function box(x: number, y: number, w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4;
      const inside = px >= x && px < x + w && py >= y && py < y + h;
      const v = inside ? 225 : 45;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, W, H);
}

const corners = (x: number, y: number, w: number, h: number) =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

describe('agreement', () => {
  it('a rectangle agrees with its own outline', () => {
    const field = edgeField(box(60, 60, 120, 120), 240);
    const a = quadAgreement(field, corners(60, 60, 120, 120));
    expect(a.coverage).toBeGreaterThan(0.9);
    expect(Math.abs(a.medianOffsetPx!), 'and sits where it says it does').toBeLessThan(3);
  });

  it('and does not agree with an outline drawn somewhere else', () => {
    const field = edgeField(box(60, 60, 120, 120), 240);
    // Far enough away that no side can reach the real box.
    const a = quadAgreement(field, corners(60, 60, 120, 120).map((p) => ({ x: p.x, y: p.y + 90 })));
    expect(a.coverage).toBeLessThan(0.3);
  });

  it('reads the offset of an outline that is close but shifted', () => {
    const field = edgeField(box(60, 60, 120, 120), 240);
    // Eight pixels down: the top side's edge now sits eight px against its
    // outward normal (which points up), the bottom's eight px along its own.
    const a = quadAgreement(field, corners(60, 68, 120, 120));
    expect(a.coverage).toBeGreaterThan(0.9);
    expect(a.sides[0].medianOffsetPx!, 'top side reaches back up for its edge').toBeGreaterThan(5);
    expect(a.sides[2].medianOffsetPx!, 'bottom side reaches back up too').toBeLessThan(-5);
  });

  it('gives the same answer whichever way round the corners are listed', () => {
    const field = edgeField(box(60, 60, 120, 120), 240);
    const forward = quadAgreement(field, corners(60, 60, 120, 120));
    const reversed = quadAgreement(field, [...corners(60, 60, 120, 120)].reverse());
    expect(reversed.coverage).toBeCloseTo(forward.coverage, 5);
  });

  it('names the side that disagrees instead of averaging it away', () => {
    // A box open at the bottom: three real sides, one that is not there. This
    // is the shape of the bad KALLAX lock — a pose held up by its top edge
    // while its bottom edge sits on nothing.
    const img = box(60, 60, 120, 120);
    for (let py = 175; py < H; py++) {
      for (let px = 60; px < 180; px++) {
        const i = (py * W + px) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 225;
      }
    }
    const field = edgeField(img, 240);
    const a = quadAgreement(field, corners(60, 60, 120, 120));
    expect(weakestSide(a), 'the missing side is found').toBeLessThan(0.3);
    expect(a.coverage, 'while the average still looks respectable').toBeGreaterThan(0.6);
  });

  it('says nothing about a blank frame rather than inventing an outline', () => {
    const blank = new ImageData(new Uint8ClampedArray(W * H * 4).fill(138), W, H);
    for (let i = 3; i < blank.data.length; i += 4) blank.data[i] = 255;
    const a = quadAgreement(edgeField(blank, 240), corners(60, 60, 120, 120));
    expect(a.coverage).toBe(0);
    expect(a.medianOffsetPx).toBeUndefined();
  });

  it('refuses a quad that is not one', () => {
    const field = edgeField(box(60, 60, 120, 120), 240);
    expect(quadAgreement(field, [{ x: 0, y: 0 }]).samples).toBe(0);
  });
});
