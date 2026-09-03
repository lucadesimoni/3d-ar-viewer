import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Connector, Pose, Quat, Vec3 } from './types';

export const IDENTITY_POSE: Pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

export const v3 = (v: Vec3): Vector3 => new Vector3(v[0], v[1], v[2]);
export const q4 = (q: Quat): Quaternion => new Quaternion(q[0], q[1], q[2], q[3]);
export const toVec3 = (v: Vector3): Vec3 => [v.x, v.y, v.z];
export const toQuat = (q: Quaternion): Quat => [q.x, q.y, q.z, q.w];

export const clonePose = (p: Pose): Pose => ({
  position: [...p.position] as Vec3,
  rotation: [...p.rotation] as Quat,
});

export const poseMatrix = (p: Pose): Matrix4 =>
  new Matrix4().compose(v3(p.position), q4(p.rotation), new Vector3(1, 1, 1));

export function matrixToPose(m: Matrix4): Pose {
  const pos = new Vector3();
  const rot = new Quaternion();
  const scale = new Vector3();
  m.decompose(pos, rot, scale);
  return { position: toVec3(pos), rotation: toQuat(rot.normalize()) };
}

/** Compose `parent ∘ child` — i.e. `child` expressed in `parent`'s frame. */
export const composePose = (parent: Pose, child: Pose): Pose =>
  matrixToPose(poseMatrix(parent).multiply(poseMatrix(child)));

export const invertPose = (p: Pose): Pose => matrixToPose(poseMatrix(p).invert());

/** Metres between two poses' origins. */
export const poseDistance = (a: Pose, b: Pose): number => v3(a.position).distanceTo(v3(b.position));

/** Smallest rotation angle between two orientations, in radians (0..π). */
export function angleBetween(a: Quat, b: Quat): number {
  const qa = q4(a).normalize();
  const qb = q4(b).normalize();
  const dot = Math.min(1, Math.abs(qa.dot(qb)));
  return 2 * Math.acos(dot);
}

export const DEG = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const M_TO_MM = 1000;

/**
 * Orthonormal frame for a connector, in the owning part's local space.
 *
 * `axis` becomes +Z and `up` is projected to become +Y, matching three.js's
 * convention so the resulting quaternion can be handed straight to a mesh.
 * A degenerate `up` (parallel to the axis) is replaced rather than throwing —
 * imported CAD data is routinely sloppy here.
 */
const connectorFrameCache = new WeakMap<Connector, Pose>();

export function connectorLocalFrame(c: Connector): Pose {
  // A connector's local frame is a pure function of its immutable fields, yet it
  // is queried twice per mate on every diagnostics run. Memoising by connector
  // identity removes that repeated matrix work on large assemblies.
  const cached = connectorFrameCache.get(c);
  if (cached) return cached;
  const frame = computeConnectorLocalFrame(c);
  connectorFrameCache.set(c, frame);
  return frame;
}

function computeConnectorLocalFrame(c: Connector): Pose {
  const axis = v3(c.axis).normalize();
  let up = v3(c.up);
  if (up.lengthSq() < 1e-12 || Math.abs(up.clone().normalize().dot(axis)) > 0.999) {
    up = Math.abs(axis.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  }
  const z = axis;
  const x = new Vector3().crossVectors(up, z).normalize();
  const y = new Vector3().crossVectors(z, x).normalize();
  const m = new Matrix4().makeBasis(x, y, z);
  m.setPosition(v3(c.position));
  return matrixToPose(m);
}

/** Connector frame expressed in the assembly frame, given the part's pose. */
export const connectorWorldFrame = (partPose: Pose, c: Connector): Pose =>
  composePose(partPose, connectorLocalFrame(c));

/** Unit +Z of a pose — for a connector frame this is its insertion axis. */
export const poseAxis = (p: Pose): Vector3 =>
  new Vector3(0, 0, 1).applyQuaternion(q4(p.rotation));

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Normalise an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/**
 * Residual roll once rotational symmetry is taken into account.
 *
 * A square flange (`symmetry: 4`) is just as correct at 90 degrees as at 0, so
 * the operator should not be shown an error for it. `symmetry <= 0` is treated
 * as free rotation (a plain round pin).
 */
export function symmetryResidual(rollRad: number, symmetry: number | undefined): number {
  if (symmetry === undefined || symmetry === 1) return Math.abs(wrapAngle(rollRad));
  if (symmetry <= 0 || !Number.isFinite(symmetry)) return 0;
  const period = (2 * Math.PI) / symmetry;
  const k = Math.round(rollRad / period);
  return Math.abs(rollRad - k * period);
}
