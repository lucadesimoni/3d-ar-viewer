import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { overlappingPairs } from './spatialHash';

interface Ball { id: number; c: Vector3; r: number; }

/** Reference O(n²) implementation the grid must agree with. */
function brute(items: Ball[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].c.distanceTo(items[j].c) <= items[i].r + items[j].r) {
        out.add(`${items[i].id}-${items[j].id}`);
      }
    }
  }
  return out;
}

const key = (p: [Ball, Ball]) => {
  const [a, b] = p[0].id < p[1].id ? p : [p[1], p[0]];
  return `${a.id}-${b.id}`;
};

describe('overlappingPairs (grid broadphase)', () => {
  it('matches the brute-force sweep on random scenes', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let trial = 0; trial < 20; trial++) {
      const n = 40;
      const items: Ball[] = Array.from({ length: n }, (_, id) => ({
        id,
        c: new Vector3(rnd() * 2, rnd() * 2, rnd() * 2),
        r: 0.05 + rnd() * 0.15,
      }));
      const grid = new Set(overlappingPairs(items, (b) => b.c, (b) => b.r).map(key));
      expect(grid).toEqual(brute(items));
    }
  });

  it('handles trivial sizes', () => {
    expect(overlappingPairs([], (b: Ball) => b.c, (b) => b.r)).toHaveLength(0);
    const one: Ball = { id: 0, c: new Vector3(), r: 1 };
    expect(overlappingPairs([one], (b) => b.c, (b) => b.r)).toHaveLength(0);
  });
});
