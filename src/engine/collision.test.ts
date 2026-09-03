import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { obbContains, obbFor, obbIntersects, obbPenetration } from './collision';
import type { MeshSpec, Pose } from './types';

const box: MeshSpec = { type: 'box', size: [0.1, 0.1, 0.1] };
const at = (x: number, y: number, z: number): Pose => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });

describe('obbPenetration', () => {
  it('reports zero when boxes are clearly apart', () => {
    expect(obbPenetration(obbFor(box, at(0, 0, 0)), obbFor(box, at(1, 0, 0)))).toBe(0);
  });

  it('reports overlap depth for interpenetrating boxes', () => {
    // Two 100 mm boxes 60 mm apart overlap by 40 mm on X.
    const d = obbPenetration(obbFor(box, at(0, 0, 0)), obbFor(box, at(0.06, 0, 0)));
    expect(d).toBeCloseTo(0.04, 3);
  });

  it('finds a separating axis for a rotated box that clears', () => {
    const rot: Pose = { position: [0.14, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] };
    expect(obbIntersects(obbFor(box, at(0, 0, 0)), obbFor(box, rot))).toBe(false);
  });

  it('is symmetric', () => {
    const a = obbFor(box, at(0, 0, 0));
    const b = obbFor(box, at(0.05, 0.02, 0));
    expect(obbPenetration(a, b)).toBeCloseTo(obbPenetration(b, a), 6);
  });
});

describe('obbContains', () => {
  it('tests a point against an oriented box', () => {
    const o = obbFor(box, at(0, 0, 0));
    expect(obbContains(o, new Vector3(0, 0, 0))).toBe(true);
    expect(obbContains(o, new Vector3(0.2, 0, 0))).toBe(false);
  });
});

describe('meshHalfExtents for url models', () => {
  it('uses author-provided bounds for a glTF/GLB part', () => {
    const spec = { type: 'url' as const, url: 'part.glb', bounds: [0.2, 0.1, 0.3] as [number, number, number] };
    const o = obbFor(spec, at(0, 0, 0));
    expect(o.halfExtents.x).toBeCloseTo(0.1, 6);
    expect(o.halfExtents.y).toBeCloseTo(0.05, 6);
    expect(o.halfExtents.z).toBeCloseTo(0.15, 6);
  });

  it('falls back to a conservative box when no bounds are given', () => {
    const spec = { type: 'url' as const, url: 'part.glb', scale: 2 };
    const o = obbFor(spec, at(0, 0, 0));
    expect(o.halfExtents.x).toBeGreaterThan(0);
  });
});
