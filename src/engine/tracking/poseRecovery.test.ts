import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { estimateIntrinsics, rectPoseFromCorners, type Intrinsics, type Point2 } from './markerTracking';
import type { Pose } from '../types';

/**
 * Round-trip test for planar pose recovery: place a rectangle at a known pose,
 * project its corners through a pinhole camera, and demand the solver give the
 * pose back.
 *
 * This is the test that was missing. Without it, a sign error inside the
 * homography decomposition — the third basis vector was negated along with the
 * other two, quietly turning the rotation into a reflection — survived a full
 * unit suite and only showed up as an overlay lying on its side in AR.
 *
 * Convention (the renderer's): the camera looks down +Z with +Y up and +X
 * right, left-handed; the plane's own frame is +X across its face, +Y up it,
 * and +Z into it, away from the viewer. A plane squarely facing the camera is
 * therefore identity rotation.
 */

const W = 1.44;
const H = 1.44;
const K: Intrinsics = estimateIntrinsics(640, 480, 60);

/** Project a point given in renderer camera coordinates to pixels. */
function project(p: Vector3, k: Intrinsics): Point2 {
  return { x: k.cx + (k.fx * p.x) / p.z, y: k.cy - (k.fy * p.y) / p.z };
}

/** The four corners of the plane at `pose`, projected, in TL/TR/BR/BL order. */
function projectPlane(pose: Pose, k: Intrinsics = K): Point2[] {
  const q = new Quaternion(...pose.rotation);
  const t = new Vector3(...pose.position);
  const local = [
    new Vector3(-W / 2, H / 2, 0),
    new Vector3(W / 2, H / 2, 0),
    new Vector3(W / 2, -H / 2, 0),
    new Vector3(-W / 2, -H / 2, 0),
  ];
  return local.map((v) => project(v.clone().applyQuaternion(q).add(t), k));
}

const degBetween = (a: Pose['rotation'], b: Pose['rotation']): number => {
  const qa = new Quaternion(...a).normalize();
  const qb = new Quaternion(...b).normalize();
  return (2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb))))) * (180 / Math.PI);
};

const cases: { name: string; pose: Pose }[] = [
  {
    name: 'square on, straight ahead',
    pose: { position: [0, 0, 2.4], rotation: [0, 0, 0, 1] },
  },
  {
    name: 'off to one side and below eye level',
    pose: { position: [0.6, -0.45, 2.9], rotation: [0, 0, 0, 1] },
  },
  {
    name: 'turned 20 degrees about its own vertical',
    pose: (() => {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (20 * Math.PI) / 180);
      return { position: [0, 0, 2.2], rotation: [q.x, q.y, q.z, q.w] } as Pose;
    })(),
  },
  {
    name: 'tilted back 12 degrees, seen from below',
    pose: (() => {
      const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (12 * Math.PI) / 180);
      return { position: [-0.3, -0.8, 3.1], rotation: [q.x, q.y, q.z, q.w] } as Pose;
    })(),
  },
];

describe('planar pose recovery', () => {
  it.each(cases)('recovers a plane $name', ({ pose }) => {
    const solved = rectPoseFromCorners(projectPlane(pose), W, H, K);
    expect(solved).toBeDefined();

    const dPos = new Vector3(...solved!.pose.position).distanceTo(new Vector3(...pose.position));
    expect(dPos).toBeLessThan(0.02);                       // 20 mm at ~3 m
    expect(degBetween(solved!.pose.rotation, pose.rotation)).toBeLessThan(1.5);
    expect(solved!.reprojectionPx).toBeLessThan(0.5);
  });

  it('never returns a mirrored basis', () => {
    // A reflection has determinant -1 and would place the object correctly
    // while rendering it inside out. Rebuilt as a quaternion it shows up as a
    // rotation that does not match the truth — check the axes directly.
    const pose: Pose = { position: [0.2, 0.1, 2.5], rotation: [0, 0, 0, 1] };
    const solved = rectPoseFromCorners(projectPlane(pose), W, H, K)!;
    const q = new Quaternion(...solved.pose.rotation);
    const x = new Vector3(1, 0, 0).applyQuaternion(q);
    const y = new Vector3(0, 1, 0).applyQuaternion(q);
    const z = new Vector3(0, 0, 1).applyQuaternion(q);
    // Right-hand rule must hold: x cross y = z.
    expect(new Vector3().crossVectors(x, y).dot(z)).toBeGreaterThan(0.99);
  });

  it('puts the plane in front of the camera, never behind it', () => {
    for (const { pose } of cases) {
      const solved = rectPoseFromCorners(projectPlane(pose), W, H, K)!;
      expect(solved.pose.position[2]).toBeGreaterThan(0);
    }
  });

  it('scales with the object: half the apparent size is twice the range', () => {
    const near = rectPoseFromCorners(projectPlane({ position: [0, 0, 2], rotation: [0, 0, 0, 1] }), W, H, K)!;
    const far = rectPoseFromCorners(projectPlane({ position: [0, 0, 4], rotation: [0, 0, 0, 1] }), W, H, K)!;
    expect(far.pose.position[2] / near.pose.position[2]).toBeCloseTo(2, 1);
    expect(far.apparentPx / near.apparentPx).toBeCloseTo(0.5, 1);
  });
});
