import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { registerPoints, registrationDrift, type Correspondence } from './alignment';
import type { Vec3 } from './types';

/** Apply a known rigid transform to build a perfect correspondence set. */
function transform(p: Vec3, q: Quaternion, t: Vec3): Vec3 {
  const v = new Vector3(...p).applyQuaternion(q).add(new Vector3(...t));
  return [v.x, v.y, v.z];
}

describe('registerPoints', () => {
  it('recovers a known rotation + translation to sub-millimetre', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6).normalize();
    const t: Vec3 = [0.3, -0.1, 0.05];
    const model: Vec3[] = [
      [0, 0, 0], [0.2, 0, 0], [0, 0.15, 0], [0, 0, 0.25], [0.1, 0.1, 0.1],
    ];
    const points: Correspondence[] = model.map((m) => ({ model: m, world: transform(m, q, t) }));
    const reg = registerPoints(points);
    expect(reg.rmsMm).toBeLessThan(0.5);
    expect(reg.quality).toBeGreaterThan(0.6);

    const rq = new Quaternion(...reg.pose.rotation);
    expect(Math.abs(rq.dot(q))).toBeGreaterThan(0.999);
  });

  it('reports high residual when a point is corrupted', () => {
    const model: Vec3[] = [[0, 0, 0], [0.2, 0, 0], [0, 0.2, 0], [0, 0, 0.2]];
    const points: Correspondence[] = model.map((m) => ({ model: m, world: m }));
    points[2].world = [0.05, 0.2, 0.03]; // 50 mm off
    const reg = registerPoints(points);
    expect(reg.maxMm).toBeGreaterThan(12);
  });

  it('refuses fewer than three points', () => {
    const reg = registerPoints([{ model: [0, 0, 0], world: [0, 0, 0] }]);
    expect(reg.quality).toBe(0);
    expect(reg.warnings.join(' ')).toMatch(/three/i);
  });

  it('warns about collinear datums', () => {
    const pts: Correspondence[] = [
      { model: [0, 0, 0], world: [0, 0, 0] },
      { model: [0.1, 0, 0], world: [0.1, 0, 0] },
      { model: [0.2, 0, 0], world: [0.2, 0, 0] },
    ];
    expect(registerPoints(pts).warnings.join(' ')).toMatch(/collinear/i);
  });
});

describe('registrationDrift', () => {
  it('measures position and angle change between poses', () => {
    const a = { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as [number, number, number, number] };
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.1);
    const b = { position: [0.01, 0, 0] as Vec3, rotation: [q.x, q.y, q.z, q.w] as [number, number, number, number] };
    const drift = registrationDrift(a, b);
    expect(drift.positionMm).toBeCloseTo(10, 1);
    expect(drift.angleDeg).toBeCloseTo(5.73, 0);
  });
});
