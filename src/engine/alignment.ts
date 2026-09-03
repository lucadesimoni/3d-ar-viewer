import { Matrix4, Quaternion, Vector3 } from 'three';
import { M_TO_MM, RAD_TO_DEG, matrixToPose, toQuat, toVec3, v3 } from './math';
import type { Pose, Vec3 } from './types';

export interface Correspondence {
  /** Point in the assembly/model frame. */
  model: Vec3;
  /** The same physical feature as measured in the world (AR) frame. */
  world: Vec3;
  label?: string;
}

export interface Registration {
  /** Rigid transform taking model coordinates into world coordinates. */
  pose: Pose;
  /** Root-mean-square residual, millimetres. */
  rmsMm: number;
  /** Worst single-point residual, millimetres. */
  maxMm: number;
  perPointMm: number[];
  /** 0..1 confidence, folding in residual and how well the points are spread. */
  quality: number;
  warnings: string[];
}

/**
 * Jacobi eigen-decomposition for a small symmetric matrix.
 *
 * Four-by-four here, so the O(n³) sweeps are free and the numerical behaviour is
 * far better than rolling a closed-form quartic.
 */
function jacobiEigen(
  input: number[][],
  sweeps = 32,
): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a = input.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-20) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  return { values: a.map((row, i) => row[i]), vectors: v };
}

/**
 * Absolute orientation by Horn's quaternion method.
 *
 * Given at least three non-collinear correspondences this recovers the rigid
 * transform that best maps model points onto measured world points, plus the
 * residuals that tell the operator whether to trust it. No scale is solved for:
 * the model is dimensionally correct and stretching it to fit would hide the
 * very registration error we want to report.
 */
export function registerPoints(points: Correspondence[]): Registration {
  const warnings: string[] = [];

  if (points.length < 3) {
    warnings.push('At least three points are needed for a full 6-DoF registration.');
    return {
      pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      rmsMm: Infinity,
      maxMm: Infinity,
      perPointMm: [],
      quality: 0,
      warnings,
    };
  }

  const model = points.map((p) => v3(p.model));
  const world = points.map((p) => v3(p.world));
  const cm = model.reduce((s, p) => s.add(p.clone()), new Vector3()).divideScalar(model.length);
  const cw = world.reduce((s, p) => s.add(p.clone()), new Vector3()).divideScalar(world.length);
  const pm = model.map((p) => p.clone().sub(cm));
  const pw = world.map((p) => p.clone().sub(cw));

  // Cross-covariance M = Σ pm_i pw_iᵀ
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < pm.length; i++) {
    const a = [pm[i].x, pm[i].y, pm[i].z];
    const b = [pw[i].x, pw[i].y, pw[i].z];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += a[r] * b[c];
  }

  const trace = M[0][0] + M[1][1] + M[2][2];
  const N = [
    [trace, M[1][2] - M[2][1], M[2][0] - M[0][2], M[0][1] - M[1][0]],
    [M[1][2] - M[2][1], M[0][0] - M[1][1] - M[2][2], M[0][1] + M[1][0], M[2][0] + M[0][2]],
    [M[2][0] - M[0][2], M[0][1] + M[1][0], -M[0][0] + M[1][1] - M[2][2], M[1][2] + M[2][1]],
    [M[0][1] - M[1][0], M[2][0] + M[0][2], M[1][2] + M[2][1], -M[0][0] - M[1][1] + M[2][2]],
  ];

  const { values, vectors } = jacobiEigen(N);
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  // Column `best` holds [w, x, y, z].
  const q = new Quaternion(
    vectors[1][best],
    vectors[2][best],
    vectors[3][best],
    vectors[0][best],
  ).normalize();

  const t = cw.clone().sub(cm.clone().applyQuaternion(q));
  const pose: Pose = { position: toVec3(t), rotation: toQuat(q) };

  const perPointMm = points.map((_, i) => {
    const mapped = model[i].clone().applyQuaternion(q).add(t);
    return mapped.distanceTo(world[i]) * M_TO_MM;
  });
  const rmsMm = Math.sqrt(perPointMm.reduce((s, d) => s + d * d, 0) / perPointMm.length);
  const maxMm = Math.max(...perPointMm);

  // Spread: a tight cluster of points gives a transform that is precise where
  // the points are and wildly wrong a metre away, so it must lower confidence.
  const spread = Math.max(...pm.map((p) => p.length()));
  if (spread < 0.05) warnings.push('Datum points are clustered — pick features further apart.');
  if (isCollinear(pm)) warnings.push('Datum points are nearly collinear — rotation about that line is unconstrained.');
  if (rmsMm > 10) warnings.push('Registration residual is high; re-touch the datums.');

  const residualScore = Math.exp(-rmsMm / 8);
  const spreadScore = Math.min(1, spread / 0.25);
  const quality = Math.max(0, Math.min(1, residualScore * (0.4 + 0.6 * spreadScore)));

  return { pose, rmsMm, maxMm, perPointMm, quality, warnings };
}

function isCollinear(centered: Vector3[]): boolean {
  if (centered.length < 3) return true;
  let axis: Vector3 | undefined;
  for (const p of centered) {
    if (p.lengthSq() < 1e-8) continue;
    if (!axis) {
      axis = p.clone().normalize();
      continue;
    }
    const cross = new Vector3().crossVectors(axis, p);
    if (cross.length() > 0.05 * p.length()) return false;
  }
  return true;
}

/**
 * Two-point registration with gravity supplying the vertical.
 *
 * This is the flow that actually works on a shop floor: touch the datum, touch a
 * second feature along a known axis, and let the device's own up-vector fix the
 * remaining degree of freedom. Only four of six DoF come from the taps, so it is
 * quick but assumes the assembly is sitting level.
 */
export function registerTwoPointWithGravity(
  originModel: Vec3,
  axisModel: Vec3,
  originWorld: Vec3,
  axisWorld: Vec3,
  worldUp: Vec3 = [0, 1, 0],
): Registration {
  const up = v3(worldUp).normalize();
  const mDir = v3(axisModel).sub(v3(originModel));
  const wDir = v3(axisWorld).sub(v3(originWorld));
  const warnings: string[] = [];

  if (mDir.length() < 1e-4 || wDir.length() < 1e-4) {
    warnings.push('The two points are coincident — pick features further apart.');
    return {
      pose: { position: [...originWorld] as Vec3, rotation: [0, 0, 0, 1] },
      rmsMm: Infinity,
      maxMm: Infinity,
      perPointMm: [],
      quality: 0,
      warnings,
    };
  }

  // Project both directions into the horizontal plane so only heading is solved.
  const flatten = (d: Vector3) => d.clone().projectOnPlane(up).normalize();
  const mFlat = flatten(mDir);
  const wFlat = flatten(wDir);
  if (mFlat.lengthSq() < 1e-6 || wFlat.lengthSq() < 1e-6) {
    warnings.push('The chosen axis is vertical; heading cannot be derived from it.');
  }

  const q = new Quaternion().setFromUnitVectors(mFlat, wFlat);
  const t = v3(originWorld).sub(v3(originModel).applyQuaternion(q));
  const lengthErrMm = Math.abs(mDir.length() - wDir.length()) * M_TO_MM;
  if (lengthErrMm > 15) {
    warnings.push(`Measured span differs from the model by ${lengthErrMm.toFixed(0)} mm.`);
  }

  return {
    pose: { position: toVec3(t), rotation: toQuat(q) },
    rmsMm: lengthErrMm / 2,
    maxMm: lengthErrMm,
    perPointMm: [0, lengthErrMm],
    quality: Math.max(0, Math.min(1, Math.exp(-lengthErrMm / 20) * 0.8)),
    warnings,
  };
}

/**
 * Drop the assembly onto a detected plane: keep the horizontal placement, set
 * the height from the plane, and align model +Y to the plane normal.
 */
export function alignToPlane(hitPoint: Vec3, planeNormal: Vec3, headingRad = 0): Pose {
  const n = v3(planeNormal).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), n);
  q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), headingRad));
  return { position: [...hitPoint] as Vec3, rotation: toQuat(q) };
}

/** Pose of the assembly implied by seeing its fiducial marker at `markerWorld`. */
export function alignToMarker(markerWorld: Pose, markerPoseInAssembly: Pose): Pose {
  const world = new Matrix4().compose(
    v3(markerWorld.position),
    new Quaternion(...markerWorld.rotation),
    new Vector3(1, 1, 1),
  );
  const inAssembly = new Matrix4().compose(
    v3(markerPoseInAssembly.position),
    new Quaternion(...markerPoseInAssembly.rotation),
    new Vector3(1, 1, 1),
  );
  return matrixToPose(world.multiply(inAssembly.invert()));
}

/** Angular difference between two registrations, degrees — used for drift alerts. */
export function registrationDrift(a: Pose, b: Pose): { positionMm: number; angleDeg: number } {
  const positionMm = v3(a.position).distanceTo(v3(b.position)) * M_TO_MM;
  const qa = new Quaternion(...a.rotation).normalize();
  const qb = new Quaternion(...b.rotation).normalize();
  const angleDeg = 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) * RAD_TO_DEG;
  return { positionMm, angleDeg };
}
