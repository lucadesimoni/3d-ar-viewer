import { Matrix4, Quaternion, Vector3 } from 'three';
import { poseMatrix, q4, v3 } from './math';
import type { MeshSpec, Pose } from './types';

/** Oriented bounding box: centre, half-extents, and a rotation, all in world. */
export interface Obb {
  center: Vector3;
  halfExtents: Vector3;
  rotation: Quaternion;
}

/** Conservative local half-extents for a mesh spec. */
export function meshHalfExtents(mesh: MeshSpec): Vector3 {
  switch (mesh.type) {
    case 'box':
      return new Vector3(mesh.size[0] / 2, mesh.size[1] / 2, mesh.size[2] / 2);
    case 'plate':
      return new Vector3(mesh.size[0] / 2, mesh.size[1] / 2, mesh.size[2] / 2);
    case 'cylinder':
    case 'tube':
      return new Vector3(mesh.radius, mesh.height / 2, mesh.radius);
    case 'sphere':
      return new Vector3(mesh.radius, mesh.radius, mesh.radius);
    case 'url':
      // Prefer the author's collision bounds; otherwise a small conservative box
      // until the renderer measures the loaded glTF and feeds real extents back.
      if (mesh.bounds) return new Vector3(mesh.bounds[0] / 2, mesh.bounds[1] / 2, mesh.bounds[2] / 2);
      return new Vector3(0.05, 0.05, 0.05).multiplyScalar(mesh.scale ?? 1);
  }
}

export function obbFor(mesh: MeshSpec, pose: Pose, shrink = 0): Obb {
  const he = meshHalfExtents(mesh);
  return {
    center: v3(pose.position),
    halfExtents: new Vector3(
      Math.max(1e-5, he.x - shrink),
      Math.max(1e-5, he.y - shrink),
      Math.max(1e-5, he.z - shrink),
    ),
    rotation: q4(pose.rotation),
  };
}

const basisOf = (q: Quaternion): Vector3[] => {
  const m = new Matrix4().makeRotationFromQuaternion(q);
  const e = m.elements;
  return [
    new Vector3(e[0], e[1], e[2]),
    new Vector3(e[4], e[5], e[6]),
    new Vector3(e[8], e[9], e[10]),
  ];
};

const projectedRadius = (axes: Vector3[], he: Vector3, axis: Vector3): number =>
  Math.abs(axes[0].dot(axis)) * he.x +
  Math.abs(axes[1].dot(axis)) * he.y +
  Math.abs(axes[2].dot(axis)) * he.z;

/**
 * Separating-axis test for two oriented boxes.
 *
 * Returns the penetration depth in metres (0 when disjoint). Fifteen axes: the
 * three face normals of each box plus the nine edge cross-products. The cross
 * products degenerate when the boxes are axis-aligned to each other, which is
 * the common case for assemblies, so near-zero axes are skipped rather than
 * normalised into noise.
 */
export function obbPenetration(a: Obb, b: Obb): number {
  const axesA = basisOf(a.rotation);
  const axesB = basisOf(b.rotation);
  const t = new Vector3().subVectors(b.center, a.center);

  const candidates: Vector3[] = [...axesA, ...axesB];
  for (const ea of axesA) {
    for (const eb of axesB) {
      const c = new Vector3().crossVectors(ea, eb);
      if (c.lengthSq() > 1e-8) candidates.push(c.normalize());
    }
  }

  let minOverlap = Infinity;
  for (const axis of candidates) {
    const ra = projectedRadius(axesA, a.halfExtents, axis);
    const rb = projectedRadius(axesB, b.halfExtents, axis);
    const dist = Math.abs(t.dot(axis));
    const overlap = ra + rb - dist;
    if (overlap <= 0) return 0; // found a separating axis
    if (overlap < minOverlap) minOverlap = overlap;
  }
  return minOverlap;
}

export const obbIntersects = (a: Obb, b: Obb): boolean => obbPenetration(a, b) > 0;

/** Cheap AABB broadphase so the O(n²) SAT pass only runs on plausible pairs. */
export function aabbRadius(o: Obb): number {
  const axes = basisOf(o.rotation);
  return (
    Math.abs(axes[0].x) * o.halfExtents.x +
    Math.abs(axes[1].x) * o.halfExtents.y +
    Math.abs(axes[2].x) * o.halfExtents.z +
    o.halfExtents.length()
  );
}

export function broadphasePairs<T extends { obb: Obb }>(items: T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const reach = a.obb.halfExtents.length() + b.obb.halfExtents.length();
      if (a.obb.center.distanceTo(b.obb.center) <= reach) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** Does a world-space point fall inside the box? Used for keep-out volumes. */
export function obbContains(o: Obb, point: Vector3): boolean {
  const local = point.clone().sub(o.center).applyQuaternion(o.rotation.clone().invert());
  return (
    Math.abs(local.x) <= o.halfExtents.x &&
    Math.abs(local.y) <= o.halfExtents.y &&
    Math.abs(local.z) <= o.halfExtents.z
  );
}

/**
 * Transform a pose by a rigid transform. Used to move a whole assembly when the
 * operator re-anchors it without touching per-part placements.
 */
export function transformPose(anchor: Pose, local: Pose): Pose {
  const m = poseMatrix(anchor).multiply(poseMatrix(local));
  const pos = new Vector3();
  const rot = new Quaternion();
  const scl = new Vector3();
  m.decompose(pos, rot, scl);
  return { position: [pos.x, pos.y, pos.z], rotation: [rot.x, rot.y, rot.z, rot.w] };
}
