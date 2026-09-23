import { describe, expect, it } from 'vitest';
import { detectGridFacade, fitLattice, matchesGridTarget } from './gridRecognition';
import { kallax, kallax4x2Assembly, KALLAX_DIMENSIONS } from '../data/kallax';
import { renderShelf as renderShelfView } from './testing/renderShelf';
import { estimateIntrinsics, rectPoseFromCorners } from '../engine/tracking/markerTracking';

/**
 * Synthesise the view of a cube shelf: bright boards, dark openings, a mid-grey
 * wall behind. Rendering the target we claim to recognise is the only honest way
 * to test the detector without a phone in front of a real shelf — the geometry
 * is exact, so the assertions can be about millimetres rather than vibes.
 */
function renderShelf(opts: {
  w: number; h: number;
  left: number; top: number; span: number;      // facade outer rect, px
  cols: number; rows: number;
  boardPx: number;
  noise?: number;
}): ImageData {
  const { w, h, left, top, span, cols, rows, boardPx } = opts;
  const data = new Uint8ClampedArray(w * h * 4);
  const put = (x: number, y: number, v: number) => {
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, 128); // wall

  const spanY = (span / cols) * rows;
  for (let y = Math.round(top); y < Math.round(top + spanY); y++) {
    for (let x = Math.round(left); x < Math.round(left + span); x++) put(x, y, 235); // boards
  }
  const pitchX = (span - boardPx) / cols;
  const pitchY = (spanY - boardPx) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round(left + boardPx + c * pitchX);
      const y0 = Math.round(top + boardPx + r * pitchY);
      for (let y = y0; y < Math.round(y0 + pitchY - boardPx); y++) {
        for (let x = x0; x < Math.round(x0 + pitchX - boardPx); x++) put(x, y, 42); // opening
      }
    }
  }
  if (opts.noise) {
    for (let i = 0; i < data.length; i += 4) {
      const n = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const d = n * opts.noise;
      data[i] += d; data[i + 1] += d; data[i + 2] += d;
    }
  }
  return new ImageData(data, w, h);
}

describe('grid facade recognition', () => {
  it('finds a 4x4 lattice and its outline in a rendered shelf', () => {
    const img = renderShelf({ w: 640, h: 480, left: 140, top: 40, span: 360, cols: 4, rows: 4, boardPx: 8 });
    const obs = detectGridFacade(img);
    expect(obs).toBeDefined();
    expect(obs!.cols).toBe(4);
    expect(obs!.rows).toBe(4);
    // What has to be right is the span — four pitches, 352 px — because that is
    // what sets scale and range. The absolute position may sit up to half a
    // board off, depending on which edge family the fit locked onto.
    const span = obs!.quad[1].x - obs!.quad[0].x;
    expect(Math.abs(span - 352) / 352).toBeLessThan(0.02);
    const centre = (obs!.quad[0].x + obs!.quad[1].x) / 2;
    expect(Math.abs(centre - 320)).toBeLessThan(8);   // half a board, in pixels
    expect(obs!.confidence).toBeGreaterThan(0.9);
  });

  it('survives sensor noise', () => {
    const img = renderShelf({ w: 640, h: 480, left: 140, top: 40, span: 360, cols: 4, rows: 4, boardPx: 8, noise: 24 });
    const obs = detectGridFacade(img);
    expect(obs?.cols).toBe(4);
    expect(obs?.rows).toBe(4);
  });

  it('stays quiet on a frame with no lattice in it', () => {
    const w = 320, h = 240;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      const v = 90 + ((i * 7919) % 60);
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
    const obs = detectGridFacade(new ImageData(data, w, h));
    // Either nothing, or something that fails the identity check — never a
    // confident 4x4 match on noise.
    if (obs) {
      expect(matchesGridTarget(obs, kallax.recognition!)).toBe(false);
    }
  });

  it('rejects the wrong shelf', () => {
    const img = renderShelf({ w: 640, h: 480, left: 160, top: 60, span: 300, cols: 3, rows: 3, boardPx: 8 });
    const obs = detectGridFacade(img);
    expect(obs?.cols).toBe(3);
    expect(matchesGridTarget(obs!, kallax.recognition!)).toBe(false);
  });

  it('recovers the real distance to a KALLAX from its lattice', () => {
    // Place a 1.44 m lattice 2.4 m from a 60-degree-FOV camera and project it.
    const K = estimateIntrinsics(640, 480, 60);
    const distance = 2.4;
    const latticeM = KALLAX_DIMENSIONS.widthM - KALLAX_DIMENSIONS.boardT;
    const halfPx = (latticeM / 2 / distance) * K.fx;
    const boardPx = (KALLAX_DIMENSIONS.boardT / distance) * K.fx;
    const span = 2 * halfPx + boardPx;   // outer face is one board wider
    const img = renderShelf({
      w: 640, h: 480, left: Math.round(320 - span / 2), top: Math.round(240 - span / 2),
      span: Math.round(span), cols: 4, rows: 4, boardPx: Math.max(3, Math.round(boardPx)),
    });

    const obs = detectGridFacade(img);
    expect(obs).toBeDefined();
    expect(matchesGridTarget(obs!, kallax.recognition!)).toBe(true);

    const solved = rectPoseFromCorners(obs!.quad, latticeM, latticeM, K);
    expect(solved).toBeDefined();
    const range = Math.hypot(...solved!.pose.position);
    // Better than 5% — the residual is the half-pixel quantisation of the
    // rendered board edges, not a modelling error.
    expect(Math.abs(range - distance) / distance).toBeLessThan(0.05);
  });

  it('fitLattice ignores clutter that does not fit the period', () => {
    const peaks = [10, 30, 37, 50, 70, 90];   // 37 is a book leaning in a bay
    const fit = fitLattice(peaks, 2, 8, 100);
    expect(fit).toBeDefined();
    expect(fit!.spacing).toBeCloseTo(20, 1);
    expect(fit!.positions.length).toBe(5);
  });

  /**
   * A real device session: a 4x2 KALLAX with a suitcase and an instrument case
   * standing on it. Their top edges sit about one cube pitch above the top
   * board, fit the lattice perfectly, and the shelf read as 4x3 — so every
   * frame was rejected on bay count, or occasionally locked a row low.
   */
  describe('clutter standing on the shelf', () => {
    const target = kallax4x2Assembly.recognition!;
    const left = 110;
    const top = 190;
    const span = 400;
    const pitch = span / 4;
    const cases: [string, { x: number; y: number; w: number; h: number; value: number }[]][] = [
      ['one case on the left', [{ x: left + 20, y: top - pitch, w: span * 0.45, h: pitch, value: 30 }]],
      ['a wide case', [{ x: left + 10, y: top - pitch, w: span * 0.8, h: pitch, value: 30 }]],
      ['two cases', [
        { x: left + 10, y: top - pitch, w: span * 0.3, h: pitch, value: 30 },
        { x: left + span * 0.5, y: top - pitch * 0.98, w: span * 0.35, h: pitch * 0.98, value: 25 },
      ]],
      // As wide as the shelf: every line spans the facade, so only the rule
      // that clutter stands on furniture rather than under it can decide.
      ['a box the full width of the shelf', [{ x: left, y: top - pitch, w: span, h: pitch, value: 30 }]],
    ];
    for (const [name, clutter] of cases) {
      it(`${name}: reads the 4x2 it is looking for, not a 4x3`, () => {
        const frame = renderShelfView({ width: 640, height: 640, left, top, span, cols: 4, rows: 2, clutter });
        const blind = detectGridFacade(frame);
        expect(blind?.rows, 'the scene really does read as an extra row without the target').toBe(3);
        const obs = detectGridFacade(frame, { target })!;
        expect(obs.cols).toBe(4);
        expect(obs.rows).toBe(2);
        expect(matchesGridTarget(obs, target)).toBe(true);
        expect(obs.yLines[0], 'and the top line is the top board, not the case').toBeGreaterThan(top - pitch / 3);
      });
    }

    it('changes nothing on a clean shelf', () => {
      const frame = renderShelfView({ width: 640, height: 640, left, top, span, cols: 4, rows: 2 });
      expect(detectGridFacade(frame, { target })).toEqual(detectGridFacade(frame));
    });
  });
});
