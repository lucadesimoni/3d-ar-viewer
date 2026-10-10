import type { Pose } from './types';

/**
 * Where the floor is, from the platform's own surface hits.
 *
 * A `local-floor` session promises y = 0 is the floor, and a device log says
 * how far to trust that: three sessions in one page load put the floor the
 * operator tapped at -0.06, +0.26 and +0.19 m. The hit-test planes are the
 * measurement; y = 0 is the platform's guess.
 *
 * Not every horizontal surface is the floor, and the one that matters most
 * here is the shelf's own top: a 4x2 KALLAX is 0.77 m tall, almost exactly
 * two of its rows, so taken for the floor it would "correct" a right lock
 * two rows up. Two rules keep it out. A surface counts only when it is well
 * below the phone (`MIN_DROP_M`: people hold a phone above a metre, and the
 * real floor sat 1.03 and 1.27 m down in that log, the shelf top 0.5-0.75),
 * and the floor is the lowest surface seen often enough to be real, not a
 * single stray hit.
 */
const BIN_M = 0.02;
/** Hits within a bin either side before a height counts as seen. */
const MIN_HITS = 8;
/** How far below the phone a surface must be to be taken for the floor. */
export const MIN_DROP_M = 0.8;
/** A surface is horizontal when its normal is within ~18 degrees of up. */
const MIN_UP = 0.95;

export class FloorEstimate {
  private readonly bins = new Map<number, { n: number; sum: number }>();

  /** One hit-test result, and where the phone was when it came. */
  addHit(hit: Pose, cameraY: number): void {
    const [x, , z] = hit.rotation;
    // The hit pose's +Y is the surface normal; its world-up component.
    const upY = 1 - 2 * (x * x + z * z);
    if (upY < MIN_UP) return;
    const h = hit.position[1];
    if (cameraY - h < MIN_DROP_M) return;
    const key = Math.round(h / BIN_M);
    const bin = this.bins.get(key) ?? { n: 0, sum: 0 };
    bin.n += 1;
    bin.sum += h;
    this.bins.set(key, bin);
  }

  /** The floor's height, once a low surface has been seen enough; else undefined. */
  get floorY(): number | undefined {
    const keys = [...this.bins.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      let n = 0;
      let sum = 0;
      for (const k of [key - 1, key, key + 1]) {
        const bin = this.bins.get(k);
        if (bin) { n += bin.n; sum += bin.sum; }
      }
      if (n >= MIN_HITS) return sum / n;
    }
    return undefined;
  }

  reset(): void {
    this.bins.clear();
  }
}

/**
 * How close a base must be to the floor, after at most one row's correction.
 *
 * The device session's good locks sat 1-3 cm from the floor the operator
 * tapped once corrected; its bad bursts (confidence 0.43-0.54, the facade
 * half out of view) 11-26 cm off any row. Ten centimetres keeps the first
 * and refuses the second.
 */
export const FLOOR_MATCH_M = 0.1;

/**
 * How a recognised floor-standing object's base meets the floor.
 *
 * `{ rows }` to move it down by (negative: up) so it stands on the floor: 0
 * when it already does, ±1 when the lattice was read a row off. Only ever one
 * row: the misreading this answers is one extra board line. Undefined when no
 * row puts it within `FLOOR_MATCH_M` of the floor — a pose the floor says is
 * impossible, to be ignored rather than shown.
 */
export function floorFit(baseY: number, floorY: number, rowPitchM: number): { rows: number } | undefined {
  const off = baseY - floorY;
  let best: { rows: number; miss: number } | undefined;
  for (const rows of [0, 1, -1]) {
    const miss = Math.abs(off - rows * rowPitchM);
    if (miss <= FLOOR_MATCH_M && (!best || miss < best.miss)) best = { rows, miss };
  }
  return best && { rows: best.rows };
}
