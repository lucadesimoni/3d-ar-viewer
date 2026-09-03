import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  M_TO_MM,
  RAD_TO_DEG,
  clonePose,
  composePose,
  connectorLocalFrame,
  connectorWorldFrame,
  invertPose,
  matrixToPose,
  poseMatrix,
  q4,
  symmetryResidual,
  v3,
} from './math';
import type { Connector, MateDef, PartDef, Pose, Tolerance } from './types';

/**
 * How far a residual sits from nominal, split into the components a fitter
 * actually cares about. Keeping axial and lateral apart matters: 2 mm of axial
 * float on a bolted joint is a torque problem, 2 mm laterally is a hole that
 * will not line up.
 */
export interface MateResidual {
  /** Along the insertion axis. Negative = not pushed in far enough. */
  axialMm: number;
  /** Perpendicular to the insertion axis — the "hole misalignment" number. */
  lateralMm: number;
  /** Angle between the two insertion axes. */
  tiltDeg: number;
  /** Rotation about the insertion axis, after symmetry is factored out. */
  rollDeg: number;
  /** Combined positional error, for ranking candidates. */
  positionMm: number;
  /** Combined angular error. */
  angleDeg: number;
}

export type FitStatus = 'ok' | 'warn' | 'fail';

export interface MateEvaluation {
  mateId: string;
  residual: MateResidual;
  status: FitStatus;
  /** True when the parts are close enough to be considered "engaged" at all. */
  engaged: boolean;
  /** Engaged but short of nominal insertion depth. */
  unseated: boolean;
}

export interface SnapCandidate {
  mate: MateDef;
  /** Pose the moving part would take if this snap were accepted. */
  snappedPose: Pose;
  residual: MateResidual;
  /** Lower is better. Blends position and angle into one ranking number. */
  score: number;
}

export interface SnapOptions {
  /** Capture radius, metres. Beyond this the snap is not offered at all. */
  captureRadiusM?: number;
  /** Capture cone half-angle, degrees. */
  captureAngleDeg?: number;
  /** Weight of one degree of angular error relative to one millimetre. */
  angleWeight?: number;
}

const DEFAULT_SNAP: Required<SnapOptions> = {
  captureRadiusM: 0.06,
  captureAngleDeg: 35,
  angleWeight: 1.5,
};

export const DEFAULT_TOLERANCE: Tolerance = {
  positionMm: 1.5,
  angleDeg: 1.5,
  warnPositionMm: 1.0,
  warnAngleDeg: 1.0,
};

/**
 * The frame the moving connector must reach to be mated with `target`.
 *
 * Two connectors mate face-to-face, so the insertion axes are anti-parallel:
 * spin the target frame 180 degrees about its own X to flip +Z (and +Y with it).
 */
export function mateTargetFrame(target: Pose): Pose {
  const flip = new Matrix4().makeRotationX(Math.PI);
  return matrixToPose(poseMatrix(target).multiply(flip));
}

/** Signed roll of `q` about its own Z axis (swing-twist decomposition). */
function twistAboutZ(q: Quaternion): number {
  // The twist component keeps only the Z part of the rotation axis.
  const twist = new Quaternion(0, 0, q.z, q.w);
  if (twist.lengthSq() < 1e-12) return 0;
  twist.normalize();
  return 2 * Math.atan2(twist.z, twist.w);
}

/**
 * Compare where a connector *is* against where it *should be*.
 *
 * Both frames are in the assembly frame. `symmetry` comes from the moving
 * connector and removes rolls that are mechanically equivalent.
 */
export function residualBetween(actual: Pose, desired: Pose, symmetry?: number): MateResidual {
  const delta = composePose(invertPose(desired), actual);
  const t = v3(delta.position);
  const axial = t.z;
  const lateral = Math.hypot(t.x, t.y);

  const dq = q4(delta.rotation).normalize();
  const zAxis = new Vector3(0, 0, 1).applyQuaternion(dq);
  const tilt = Math.acos(Math.min(1, Math.max(-1, zAxis.z)));
  const roll = symmetryResidual(twistAboutZ(dq), symmetry);

  const positionMm = Math.hypot(axial, lateral) * M_TO_MM;
  const angleDeg = Math.hypot(tilt, roll) * RAD_TO_DEG;

  return {
    axialMm: axial * M_TO_MM,
    lateralMm: lateral * M_TO_MM,
    tiltDeg: tilt * RAD_TO_DEG,
    rollDeg: roll * RAD_TO_DEG,
    positionMm,
    angleDeg,
  };
}

export function classify(residual: MateResidual, tol: Tolerance): FitStatus {
  if (residual.positionMm > tol.positionMm || residual.angleDeg > tol.angleDeg) return 'fail';
  const warnPos = tol.warnPositionMm ?? tol.positionMm * 0.66;
  const warnAng = tol.warnAngleDeg ?? tol.angleDeg * 0.66;
  if (residual.positionMm > warnPos || residual.angleDeg > warnAng) return 'warn';
  return 'ok';
}

const findConnector = (part: PartDef, id: string): Connector | undefined =>
  part.connectors.find((c) => c.id === id);

/**
 * Evaluate one mate given where both parts currently sit.
 *
 * Returns `undefined` when the mate references geometry that does not exist,
 * which happens with a stale step definition after a CAD revision — callers
 * surface that as an authoring error rather than a fit error.
 */
export function evaluateMate(
  mate: MateDef,
  partA: PartDef,
  poseA: Pose,
  partB: PartDef,
  poseB: Pose,
  tol: Tolerance,
): MateEvaluation | undefined {
  const ca = findConnector(partA, mate.a.connectorId);
  const cb = findConnector(partB, mate.b.connectorId);
  if (!ca || !cb) return undefined;

  const actual = connectorWorldFrame(poseA, ca);
  const desired = mateTargetFrame(connectorWorldFrame(poseB, cb));
  const residual = residualBetween(actual, desired, ca.symmetry);

  const engaged = residual.positionMm < 25 && residual.tiltDeg < 25;
  const depthMm = (ca.engagementDepth ?? 0) * M_TO_MM;
  // Negative axial means the moving connector has not travelled far enough in.
  const unseated = engaged && depthMm > 0 && residual.axialMm < -Math.max(0.5, depthMm * 0.1);

  return {
    mateId: mate.id,
    residual,
    status: classify(residual, tol),
    engaged,
    unseated,
  };
}

/**
 * Pose that puts `part`'s connector exactly on `desired`.
 *
 * The roll is picked from the symmetric family nearest to the part's current
 * orientation, so accepting a snap never spins a part through 90 degrees when
 * a 0-degree solution was right there.
 */
export function solveSnapPose(
  currentPose: Pose,
  connector: Connector,
  desired: Pose,
): Pose {
  const local = connectorLocalFrame(connector);
  const actual = composePose(currentPose, local);
  const delta = composePose(invertPose(desired), actual);
  const roll = twistAboutZ(q4(delta.rotation).normalize());

  const symmetry = connector.symmetry;
  let snapRoll = 0;
  if (symmetry !== undefined && symmetry !== 1) {
    if (symmetry <= 0 || !Number.isFinite(symmetry)) {
      snapRoll = roll; // free spin: keep whatever the operator had
    } else {
      const period = (2 * Math.PI) / symmetry;
      snapRoll = Math.round(roll / period) * period;
    }
  }

  const adjusted = matrixToPose(
    poseMatrix(desired).multiply(new Matrix4().makeRotationZ(snapRoll)),
  );
  return composePose(adjusted, invertPose(local));
}

/**
 * Rank the mates the moving part could snap to right now.
 *
 * Only mates whose already-installed side has a known pose are considered, so a
 * step's mates go live exactly as their prerequisites get placed.
 */
export function findSnapCandidates(
  movingPart: PartDef,
  movingPose: Pose,
  mates: MateDef[],
  partsById: Map<string, PartDef>,
  posesById: Map<string, Pose>,
  options: SnapOptions = {},
): SnapCandidate[] {
  const opts = { ...DEFAULT_SNAP, ...options };
  const out: SnapCandidate[] = [];

  for (const mate of mates) {
    if (mate.a.partId !== movingPart.id) continue;
    const other = partsById.get(mate.b.partId);
    const otherPose = posesById.get(mate.b.partId);
    if (!other || !otherPose) continue;

    const ca = findConnector(movingPart, mate.a.connectorId);
    const cb = findConnector(other, mate.b.connectorId);
    if (!ca || !cb) continue;
    if (!ca.accepts.includes(cb.kind) && !cb.accepts.includes(ca.kind)) continue;

    const desired = mateTargetFrame(connectorWorldFrame(otherPose, cb));
    const actual = connectorWorldFrame(movingPose, ca);
    const residual = residualBetween(actual, desired, ca.symmetry);

    if (residual.positionMm > opts.captureRadiusM * M_TO_MM) continue;
    if (residual.tiltDeg > opts.captureAngleDeg) continue;

    out.push({
      mate,
      snappedPose: solveSnapPose(movingPose, ca, desired),
      residual,
      score: residual.positionMm + residual.angleDeg * opts.angleWeight,
    });
  }

  return out.sort((a, b) => a.score - b.score);
}

/** Best snap, or `undefined` when nothing is in range. */
export const bestSnap = (candidates: SnapCandidate[]): SnapCandidate | undefined => candidates[0];

/**
 * Pose the moving part would take if every mate in `mates` were satisfied at
 * once. Used to draw the ghost preview for the active step.
 */
export function nominalPoseFor(part: PartDef): Pose {
  return clonePose(part.targetPose);
}

/** Interpolate between two poses — drives the snap "settle" animation. */
export function blendPose(from: Pose, to: Pose, t: number): Pose {
  const p = v3(from.position).lerp(v3(to.position), t);
  const q = q4(from.rotation).clone().slerp(q4(to.rotation), t);
  return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
}
