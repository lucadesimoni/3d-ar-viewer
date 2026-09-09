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
