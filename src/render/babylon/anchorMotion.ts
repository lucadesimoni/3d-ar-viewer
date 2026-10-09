import type { Pose } from '../../engine/types';

/**
 * How far the platform has to move an anchor before it is worth moving with it.
 *
 * A real device log (Android/Edge, `bbd065f+`) reported ~30 anchor corrections
 * a second while the position stayed identical to three decimals for seconds on
 * end: 1350 corrections in 45 s, almost all of them noise. Writing each one
 * through re-runs everything that watches the placement and gives the display a
 * sub-millimetre tremble. Two millimetres is well under what an operator can
 * see at arm's length and well over what the tracker jitters by at rest.
 */
export const ANCHOR_POSITION_EPS_M = 0.002;

/** The same idea for the turn: a quarter of a degree is 4 mm at a metre. */
export const ANCHOR_ROTATION_EPS_RAD = (0.25 * Math.PI) / 180;

/** The angle between two orientations, in radians, sign of the quaternion aside. */
export function angleBetween(a: Pose['rotation'], b: Pose['rotation']): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

/** How far apart two anchor reports are, in metres. */
export function distanceBetween(a: Pose['position'], b: Pose['position']): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Is this report different enough from the last one we acted on to act on?
 *
 * Compared against the last *applied* pose, never against the last *reported*
 * one: a slow, steady drift of a tenth of a millimetre a frame would otherwise
 * be discarded for ever and the assembly would creep away from the spot it was
 * placed on without a single correction ever clearing the bar. Measured this
 * way the small differences accumulate until they cross it, and the 1.19 m
 * relocalisation the same log recorded passes on the frame it arrives.
 */
export function anchorMoved(applied: Pose, reported: Pose): boolean {
  return distanceBetween(applied.position, reported.position) >= ANCHOR_POSITION_EPS_M
    || angleBetween(applied.rotation, reported.rotation) >= ANCHOR_ROTATION_EPS_RAD;
}

/** Two poses the app might ask for: the same one, or a different one. */
export function samePose(a: Pose | undefined, b: Pose | undefined): boolean {
  if (!a || !b) return a === b;
  return a.position.every((v, i) => v === b.position[i])
    && a.rotation.every((v, i) => v === b.rotation[i]);
}

/**
 * How much of what the platform says about the placed spot the assembly takes.
 *
 * Followed again, after the "every tap moves it" reports turned out to be the
 * app making a new anchor on every tap. What remained in the logs was the
 * platform refining a fresh anchor by 4–8 cm in its first seconds, which is
 * the floor being learned better and worth taking. But a step that large is
 * not refinement, and neither is a run of small steps that carries the
 * assembly off its spot (one log climbed 22 cm in 2–10 cm steps): each step,
 * and the total from where it was placed, stays under these.
 */
export const FOLLOW_STEP_MAX_M = 0.15;
export const FOLLOW_TOTAL_MAX_M = 0.15;
/** Taken smoothly over this long, so a correction reads as settling, not a jump. */
export const ANCHOR_EASE_MS = 300;

/** Heading about the vertical: where +Z ends up, as Babylon's yaw (left-handed, Y up). */
export function yawOf(q: Pose['rotation']): number {
  const [x, y, z, w] = q;
  return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
}

/** A rotation about the vertical alone. */
export function yawQuat(yaw: number): Pose['rotation'] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/**
 * Where an assembly standing on an anchor goes when the anchor moves from
 * `before` to `after`: carried by the same move and turn, and kept upright —
 * only the anchor's heading is taken, never a tilt, because the assembly
 * stands on a floor and a refined anchor tilting by a degree is not a reason
 * to lean a shelf.
 */
export function carryWithAnchor(assembly: Pose, before: Pose, after: Pose): Pose {
  const turn = yawOf(after.rotation) - yawOf(before.rotation);
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const vx = assembly.position[0] - before.position[0];
  const vy = assembly.position[1] - before.position[1];
  const vz = assembly.position[2] - before.position[2];
  return {
    position: [
      after.position[0] + vx * c + vz * s,
      after.position[1] + vy,
      after.position[2] - vx * s + vz * c,
    ],
    rotation: yawQuat(yawOf(assembly.rotation) + turn),
  };
}

/** Partway from one upright pose to another — `k` from 0 to 1 — by the short way round. */
export function blendUpright(from: Pose, to: Pose, k: number): Pose {
  const a = yawOf(from.rotation);
  let d = yawOf(to.rotation) - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return {
    position: [0, 1, 2].map((i) => from.position[i] + (to.position[i] - from.position[i]) * k) as Pose['position'],
    rotation: yawQuat(a + d * k),
  };
}
