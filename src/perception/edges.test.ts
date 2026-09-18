import { describe, expect, it } from 'vitest';
import { edgeField, findEdgeAlongNormal } from './edges';

const W = 240;
const H = 240;

/** A frame that is dark left of `edgeX` and light right of it. */
function stepEdge(edgeX: number, dark = 40, light = 220): ImageData {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = x < edgeX ? dark : light;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, W, H);
}

function flat(value = 138): ImageData {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return new ImageData(data, W, H);
}

describe('edges', () => {
  it('finds an edge where it is, not where it was expected', () => {
    const field = edgeField(stepEdge(120), 240);
    // Ask from 6 px short of the edge, looking along +x.
    const hit = findEdgeAlongNormal(field, 114, 120, 1, 0);
    expect(hit, 'the edge is well inside the search window').toBeDefined();
    // A step spans two pixels of central-difference gradient, so the recovered
    // position is allowed a pixel of slack either way.
    expect(114 + hit!.offsetPx).toBeGreaterThan(118.5);
    expect(114 + hit!.offsetPx).toBeLessThan(121.5);
  });

  it('signs the offset by the normal it was given', () => {
    const field = edgeField(stepEdge(120), 240);
    const ahead = findEdgeAlongNormal(field, 114, 120, 1, 0);
    const behind = findEdgeAlongNormal(field, 126, 120, 1, 0);
    expect(ahead!.offsetPx, 'edge further along the normal reads positive').toBeGreaterThan(0);
    expect(behind!.offsetPx, 'edge behind the point reads negative').toBeLessThan(0);
  });

  it('says nothing rather than something about a blank wall', () => {
    const field = edgeField(flat(), 240);
    expect(findEdgeAlongNormal(field, 120, 120, 1, 0)).toBeUndefined();
  });

  it('will not reach past its search window for an edge', () => {
    const field = edgeField(stepEdge(120), 240);
    // 10 px short with a 12 px window reaches it; 30 px short does not, and
    // must not answer with an edge that far away — that is another object.
    expect(findEdgeAlongNormal(field, 110, 120, 1, 0), 'inside the window').toBeDefined();
    expect(findEdgeAlongNormal(field, 90, 120, 1, 0), 'outside it').toBeUndefined();
  });

  it('searches across the edge, not along it', () => {
    const field = edgeField(stepEdge(120), 240);
    // Looking along the edge rather than across it: every sample sits on the
    // same side of the step, so there is nothing to find.
    expect(findEdgeAlongNormal(field, 114, 120, 0, 1)).toBeUndefined();
  });

  it('works in full-resolution pixels when the frame is downsampled', () => {
    // 240 wide analysed at 60: scale 4, so a search stated in full-resolution
    // pixels has to be divided down before it indexes the field.
    const field = edgeField(stepEdge(120), 60);
    expect(field.gray.scale).toBe(4);
    const hit = findEdgeAlongNormal(field, 108, 120, 1, 0, 24);
    expect(hit).toBeDefined();
    expect(108 + hit!.offsetPx).toBeGreaterThan(114);
    expect(108 + hit!.offsetPx).toBeLessThan(126);
  });

  it('a flat frame has a floor no gradient in it can beat', () => {
    expect(edgeField(flat(), 240).floor).toBe(0);
    expect(edgeField(stepEdge(120), 240).floor).toBeGreaterThan(0);
  });
});
