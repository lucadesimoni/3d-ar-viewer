import { Vector3 } from 'three';

/**
 * Uniform-grid spatial hash for broadphase queries.
 *
 * The diagnostics engine runs on every part placement, and its interference
 * check is the expensive part: naively it compares every pair of parts, which is
 * O(n²) and starts to bite on assemblies of a few hundred parts (the 108-part
 * rack already generates ~5,800 pairs). Bucketing part centres into a grid turns
 * that into a near-linear sweep of only spatially-adjacent candidates, so the
 * cost tracks the number of parts that could actually touch rather than the
 * square of the part count.
 */
export class SpatialHash<T> {
  private cells = new Map<string, T[]>();
  private readonly inv: number;

  /** `cellSize` should be about the largest object diameter in the scene. */
  constructor(cellSize: number) {
    this.inv = 1 / Math.max(1e-4, cellSize);
  }

  private key(x: number, y: number, z: number): string {
    return `${Math.floor(x * this.inv)},${Math.floor(y * this.inv)},${Math.floor(z * this.inv)}`;
  }

  insert(center: Vector3, item: T): void {
    const k = this.key(center.x, center.y, center.z);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(item);
    else this.cells.set(k, [item]);
  }

  /** Items in the 3×3×3 neighbourhood of `center` (its own cell included). */
  neighbours(center: Vector3): T[] {
    const out: T[] = [];
    const cx = Math.floor(center.x * this.inv);
    const cy = Math.floor(center.y * this.inv);
    const cz = Math.floor(center.z * this.inv);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (let z = cz - 1; z <= cz + 1; z++) {
          const bucket = this.cells.get(`${x},${y},${z}`);
          if (bucket) out.push(...bucket);
        }
      }
    }
    return out;
  }

  clear(): void {
    this.cells.clear();
  }
}

/**
 * All pairs of items whose bounding spheres could overlap, found via a grid.
 *
 * Equivalent in result to the brute-force O(n²) sweep, but the cell size is set
 * to twice the largest radius so any genuinely-overlapping pair lands within the
 * 3×3×3 neighbourhood. Each pair is emitted once; the `index` field keeps the
 * de-duplication cheap without a secondary set.
 */
export function overlappingPairs<T>(
  items: T[],
  centerOf: (item: T) => Vector3,
  radiusOf: (item: T) => number,
): [T, T][] {
  if (items.length < 2) return [];

  let maxRadius = 0;
  for (const it of items) maxRadius = Math.max(maxRadius, radiusOf(it));
  // Below a handful of items the grid's overhead is not worth it.
  const cellSize = Math.max(1e-3, maxRadius * 2);

  const grid = new SpatialHash<{ item: T; index: number }>(cellSize);
  const centers = items.map(centerOf);
  const radii = items.map(radiusOf);
  items.forEach((item, index) => grid.insert(centers[index], { item, index }));

  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (const cand of grid.neighbours(centers[i])) {
      // Only i < index avoids both re-emitting and self-pairing.
      if (cand.index <= i) continue;
      const reach = radii[i] + radii[cand.index];
      if (centers[i].distanceTo(centers[cand.index]) <= reach) pairs.push([items[i], cand.item]);
    }
  }
  return pairs;
}
