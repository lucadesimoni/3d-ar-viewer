import { findEdgeAlongNormal, type EdgeField } from './edges';

/**
 * Does the image agree with the outline the geometry predicts?
 *
 * The one measurement that turns a pose from a claim into a checkable one. Given
 * where an object's silhouette should land in the frame, walk that outline and
 * ask at each point whether there is really an edge there. The share that
 * answer yes is presence; the median of how far off they were is the snap
 * signal.
 *
 * Why this and not more lattice-finding: the recognition path already searches
 * the frame bottom-up for a periodic structure, and a device log showed what
 * that costs. Two instrument cases standing on a real KALLAX produced a fourth
 * board line, the shelf read as three rows, and a pose built on the wrong pair
 * of lines committed at 0.94 confidence with the bottom board drawn into the
 * floor. Nothing in the detector could object, because every line it used was a
 * real edge — just not the object's.
 *
 * Checked against that same frame before this was built, so the numbers below
 * are measured rather than hoped for. Sampling the outline the app actually
 * believed in against the outline the shelf actually has:
 *
 * | | overall | top | bottom | left |
 * |---|---|---|---|---|
 * | the real facade | 0.63 | 1.00 | 0.79 | 0.63 |
 * | the committed pose | 0.31 | 0.88 | **0.04** | 0.33 |
 *
 * The disagreement is not spread evenly and that is the point: the bad pose's
 * top edge still lands on a real line — that is what fooled the detector — and
 * its bottom edge lands on bare floor, where nothing answers. A single number
 * would blur those together, so the sides are reported apart as well.
 */

export interface Point2 {
  x: number;
  y: number;
}

export interface SideAgreement {
  /** Share of this side's samples that found an edge, 0..1. */
  coverage: number;
  /** Median signed offset along the outward normal, full-resolution pixels. */
  medianOffsetPx: number | undefined;
}

export interface Agreement {
  /** Share of all samples that found a real edge, 0..1 — presence. */
  coverage: number;
  /**
   * Median signed offset over every sample that found an edge, in
   * full-resolution pixels. Undefined when nothing was found at all.
   *
   * This is the snap signal: a present object whose anchor is out by a
   * centimetre gives the same sign at most points, while noise cancels.
   */
  medianOffsetPx: number | undefined;
  /** Each side on its own, because which side disagrees is the diagnosis. */
  sides: SideAgreement[];
  /** How many points were asked in total. */
  samples: number;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface AgreementOptions {
  /** Points sampled along each side. */
  perSide?: number;
  /** How far either way an edge may sit and still be this one, full-res px. */
  searchPx?: number;
}

/**
 * Walk a projected outline and ask the image about it.
 *
 * Takes a quadrilateral rather than a rectangle because a facade seen from
 * anywhere but straight on is not a rectangle in the image, and forcing it into
 * one would put the sample points off the very edges they are meant to test.
 * Corner order only has to be a loop — the outward normal of each side is
 * derived from the quad's own centre, so a clockwise and an anticlockwise quad
 * give the same answer rather than opposite signs.
 */
export function quadAgreement(
  field: EdgeField,
  quad: Point2[],
  opts: AgreementOptions = {},
): Agreement {
  const perSide = opts.perSide ?? 16;
  const searchPx = opts.searchPx ?? 24;
  const empty: Agreement = { coverage: 0, medianOffsetPx: undefined, sides: [], samples: 0 };
  if (quad.length !== 4) return empty;

  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  const all: number[] = [];
  const sides: SideAgreement[] = [];
  let hits = 0;
  let samples = 0;

  for (let s = 0; s < 4; s++) {
    const a = quad[s];
    const b = quad[(s + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // Perpendicular to the side, turned to point away from the centre.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let nx = dy;
    let ny = -dx;
    if (nx * (mx - cx) + ny * (my - cy) < 0) { nx = -nx; ny = -ny; }

    const found: number[] = [];
    for (let i = 0; i < perSide; i++) {
      const t = (i + 0.5) / perSide;
      const u = a.x + dx * t;
      const v = a.y + dy * t;
      samples++;
      const hit = findEdgeAlongNormal(field, u, v, nx, ny, searchPx);
      if (hit) { hits++; found.push(hit.offsetPx); all.push(hit.offsetPx); }
    }
    sides.push({ coverage: found.length / perSide, medianOffsetPx: median(found) });
  }

  return {
    coverage: samples > 0 ? hits / samples : 0,
    medianOffsetPx: median(all),
    sides,
    samples,
  };
}

/**
 * The weakest side of an outline.
 *
 * A pose can be mostly right and still be wrong in the way that matters — the
 * bad KALLAX lock held its top edge on a real line and missed the bottom one
 * entirely. Averaging hides that; asking for the worst side surfaces it.
 */
export function weakestSide(agreement: Agreement): number {
  if (agreement.sides.length === 0) return 0;
  return Math.min(...agreement.sides.map((s) => s.coverage));
}
