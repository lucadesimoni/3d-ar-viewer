import { M_TO_MM, poseDistance } from './math';
import { broadphasePairs, obbFor, obbPenetration, type Obb } from './collision';
import { DEFAULT_TOLERANCE, evaluateMate, type MateEvaluation } from './snapping';
import type { AssemblyDef, PartDef, PlacementState, Pose, StepDef, Tolerance } from './types';

export type Severity = 'error' | 'warning' | 'info';

export type DiagnosticCode =
  | 'FIT_POSITION'
  | 'FIT_ORIENTATION'
  | 'UNSEATED'
  | 'NOT_ENGAGED'
  | 'SEQUENCE_VIOLATION'
  | 'INTERFERENCE'
  | 'KEEP_OUT'
  | 'SWAPPED_PART'
  | 'MIRRORED_VARIANT'
  | 'MISSING_PART'
  | 'AUTHORING_ERROR';

export interface Diagnostic {
  id: string;
  code: DiagnosticCode;
  severity: Severity;
  /** One line, written for the operator holding the iPad — not for a developer. */
  message: string;
  /** The numbers behind the message, shown when the operator taps the row. */
  detail?: string;
  partIds: string[];
  stepId?: string;
  /** What to do about it. */
  fix?: string;
  /** Worst measured deviation, used to sort and to colour the part. */
  magnitude?: number;
}

export interface DiagnosticInput {
  assembly: AssemblyDef;
  placements: Map<string, PlacementState>;
  /** Steps the operator has marked done. */
  completedStepIds: Set<string>;
}

const fmtMm = (v: number) => `${v.toFixed(2)} mm`;
const fmtDeg = (v: number) => `${v.toFixed(2)}°`;

const toleranceFor = (assembly: AssemblyDef, step?: StepDef): Tolerance =>
  step?.tolerance ?? assembly.defaultTolerance ?? DEFAULT_TOLERANCE;

function indexParts(assembly: AssemblyDef): Map<string, PartDef> {
  return new Map(assembly.parts.map((p) => [p.id, p]));
}

/**
 * Run every rule over the current placement state.
 *
 * Ordering matters for the HUD: errors first, then by magnitude, so the top row
 * is always the thing most worth walking back to fix.
 */
export function runDiagnostics(input: DiagnosticInput): Diagnostic[] {
  const { assembly, placements, completedStepIds } = input;
  const parts = indexParts(assembly);
  const poses = new Map<string, Pose>();
  for (const [id, pl] of placements) {
    if (pl.status !== 'ghost') poses.set(id, pl.pose);
  }

  const out: Diagnostic[] = [
    ...fitDiagnostics(assembly, parts, poses),
    ...sequenceDiagnostics(assembly, poses, completedStepIds),
    ...interferenceDiagnostics(parts, poses),
    ...keepOutDiagnostics(assembly, parts, poses),
    ...swapDiagnostics(assembly, parts, poses),
    ...missingPartDiagnostics(assembly, poses, completedStepIds),
  ];

  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return out.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (b.magnitude ?? 0) - (a.magnitude ?? 0),
  );
}

/** Mate-by-mate fit checks: position, orientation, seating, engagement. */
function fitDiagnostics(
  assembly: AssemblyDef,
  parts: Map<string, PartDef>,
  poses: Map<string, Pose>,
): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const step of assembly.steps) {
    const tol = toleranceFor(assembly, step);
    for (const mate of step.mates) {
      const partA = parts.get(mate.a.partId);
      const partB = parts.get(mate.b.partId);
      if (!partA || !partB) {
        out.push({
          id: `authoring:${mate.id}`,
          code: 'AUTHORING_ERROR',
          severity: 'warning',
          message: `Step "${step.title}" references a part that is not in this revision.`,
          detail: `Mate ${mate.id} points at ${mate.a.partId} / ${mate.b.partId}.`,
          partIds: [mate.a.partId, mate.b.partId],
          stepId: step.id,
          fix: 'Re-export the assembly from CAD at the current revision.',
        });
        continue;
      }

      const poseA = poses.get(partA.id);
      const poseB = poses.get(partB.id);
      if (!poseA || !poseB) continue; // one side is not placed yet — nothing to judge

      const ev = evaluateMate(mate, partA, poseA, partB, poseB, tol);
      if (!ev) {
        out.push({
          id: `authoring:${mate.id}:connector`,
          code: 'AUTHORING_ERROR',
          severity: 'warning',
          message: `Mate ${mate.id} names a connector that no longer exists.`,
          partIds: [partA.id, partB.id],
          stepId: step.id,
          fix: 'Update the step definition to the current connector ids.',
        });
        continue;
      }

      out.push(...fitDiagnosticsForMate(ev, step, partA, partB, tol));
    }
  }

  return out;
}

function fitDiagnosticsForMate(
  ev: MateEvaluation,
  step: StepDef,
  partA: PartDef,
  partB: PartDef,
  tol: Tolerance,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const ids = [partA.id, partB.id];
  const r = ev.residual;

  if (!ev.engaged) {
    out.push({
      id: `notengaged:${ev.mateId}`,
      code: 'NOT_ENGAGED',
      severity: 'error',
      message: `${partA.name} is not mated to ${partB.name}.`,
      detail: `Connector is ${fmtMm(r.positionMm)} and ${fmtDeg(r.tiltDeg)} away from the joint.`,
      partIds: ids,
      stepId: step.id,
      fix: `Bring ${partA.name} up to the joint until it snaps.`,
      magnitude: r.positionMm,
    });
    return out;
  }

  if (r.positionMm > tol.positionMm) {
    // Lateral error is the actionable one: it is what stops a fastener going in.
    const dominant = Math.abs(r.lateralMm) >= Math.abs(r.axialMm) ? 'lateral' : 'axial';
    out.push({
      id: `fitpos:${ev.mateId}`,
      code: 'FIT_POSITION',
      severity: 'error',
      message: `${partA.name} is ${fmtMm(r.positionMm)} out of position (limit ${fmtMm(tol.positionMm)}).`,
      detail: `Lateral ${fmtMm(r.lateralMm)}, axial ${fmtMm(r.axialMm)} — dominated by ${dominant} error.`,
      partIds: ids,
      stepId: step.id,
      fix:
        dominant === 'lateral'
          ? `Slide ${partA.name} across the joint face until the locating features seat.`
          : `Push ${partA.name} further onto ${partB.name}.`,
      magnitude: r.positionMm,
    });
  } else if (ev.status === 'warn') {
    out.push({
      id: `fitwarn:${ev.mateId}`,
      code: 'FIT_POSITION',
      severity: 'warning',
      message: `${partA.name} is close to the position limit.`,
      detail: `${fmtMm(r.positionMm)} of ${fmtMm(tol.positionMm)} used.`,
      partIds: ids,
      stepId: step.id,
      fix: 'Re-seat before torquing — it will not get better under load.',
      magnitude: r.positionMm,
    });
  }

  if (r.angleDeg > tol.angleDeg) {
    const dominant = r.tiltDeg >= r.rollDeg ? 'tilt' : 'roll';
    out.push({
      id: `fitang:${ev.mateId}`,
      code: 'FIT_ORIENTATION',
      severity: 'error',
      message: `${partA.name} is ${fmtDeg(r.angleDeg)} off true (limit ${fmtDeg(tol.angleDeg)}).`,
      detail: `Tilt ${fmtDeg(r.tiltDeg)}, roll ${fmtDeg(r.rollDeg)} — dominated by ${dominant}.`,
      partIds: ids,
      stepId: step.id,
      fix:
        dominant === 'tilt'
          ? `${partA.name} is cocked in the joint. Back it off and restart the insertion square.`
          : `Rotate ${partA.name} about its axis until the keyway lines up.`,
      magnitude: r.angleDeg,
    });
  }

  if (ev.unseated) {
    out.push({
      id: `unseated:${ev.mateId}`,
      code: 'UNSEATED',
      severity: 'error',
      message: `${partA.name} is engaged but not fully seated.`,
      detail: `Short of nominal depth by ${fmtMm(Math.abs(r.axialMm))}.`,
      partIds: ids,
      stepId: step.id,
      fix: 'Press home until the shoulder contacts. Do not rely on the fastener to pull it in.',
      magnitude: Math.abs(r.axialMm),
    });
  }

  return out;
}

/** Parts installed before their prerequisites — the classic rework generator. */
function sequenceDiagnostics(
  assembly: AssemblyDef,
  poses: Map<string, Pose>,
  completed: Set<string>,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const stepsById = new Map(assembly.steps.map((s) => [s.id, s]));

  for (const step of assembly.steps) {
    const placedHere = step.partIds.filter((id) => poses.has(id));
    if (placedHere.length === 0) continue;

    const unmet = step.requires.filter((id) => !completed.has(id));
    if (unmet.length === 0) continue;

    const names = unmet.map((id) => stepsById.get(id)?.title ?? id);
    out.push({
      id: `sequence:${step.id}`,
      code: 'SEQUENCE_VIOLATION',
      severity: 'error',
      message: `"${step.title}" was started before ${names.join(', ')}.`,
      detail: `Blocked by ${unmet.length} incomplete step${unmet.length > 1 ? 's' : ''}.`,
      partIds: placedHere,
      stepId: step.id,
      fix: `Remove ${placedHere.length} part${placedHere.length > 1 ? 's' : ''} and complete ${names[0]} first.`,
      magnitude: unmet.length,
    });
  }

  return out;
}

/**
 * Solid-body interference between placed parts.
 *
 * Boxes are shrunk by half a millimetre before testing so that parts which are
 * *meant* to touch do not light up the panel; only real overlap survives.
 */
function interferenceDiagnostics(
  parts: Map<string, PartDef>,
  poses: Map<string, Pose>,
): Diagnostic[] {
  const items: { id: string; part: PartDef; obb: Obb }[] = [];
  for (const [id, pose] of poses) {
    const part = parts.get(id);
    if (part) items.push({ id, part, obb: obbFor(part.mesh, pose, 0.0005) });
  }

  const out: Diagnostic[] = [];
  for (const [a, b] of broadphasePairs(items)) {
    const depth = obbPenetration(a.obb, b.obb);
    const depthMm = depth * M_TO_MM;
    if (depthMm < 1) continue; // sub-millimetre overlap is bounding-box slop, not a clash
    out.push({
      id: `clash:${a.id}:${b.id}`,
      code: 'INTERFERENCE',
      severity: depthMm > 3 ? 'error' : 'warning',
      message: `${a.part.name} clashes with ${b.part.name} by ${fmtMm(depthMm)}.`,
      detail: 'Bounding volumes overlap; the parts cannot both be where they are.',
      partIds: [a.id, b.id],
      fix: `Back ${a.part.name} out and check the previous step's seating.`,
      magnitude: depthMm,
    });
  }
  return out;
}

/** Parts intruding into a declared keep-out volume (harness runs, service gaps). */
function keepOutDiagnostics(
  assembly: AssemblyDef,
  parts: Map<string, PartDef>,
  poses: Map<string, Pose>,
): Diagnostic[] {
  const zones = assembly.background.filter((b) => b.role === 'keepOut');
  if (zones.length === 0) return [];

  const out: Diagnostic[] = [];
  for (const zone of zones) {
    const zoneObb = obbFor(zone.mesh, zone.pose);
    for (const [id, pose] of poses) {
      const part = parts.get(id);
      if (!part) continue;
      const depthMm = obbPenetration(obbFor(part.mesh, pose), zoneObb) * M_TO_MM;
      if (depthMm < 1) continue;
      out.push({
        id: `keepout:${zone.id}:${id}`,
        code: 'KEEP_OUT',
        severity: 'warning',
        message: `${part.name} intrudes ${fmtMm(depthMm)} into "${zone.name}".`,
        detail: 'Keep-out volumes reserve space for service access and harness routing.',
        partIds: [id],
        fix: `Reposition ${part.name} clear of the reserved volume.`,
        magnitude: depthMm,
      });
    }
  }
  return out;
}

/**
 * Part placed where a *different* part belongs.
 *
 * Two flavours: a mirrored variant (left fitted where right belongs, which is
 * the one that survives inspection and fails in the field), and a plain swap.
 */
function swapDiagnostics(
  assembly: AssemblyDef,
  parts: Map<string, PartDef>,
  poses: Map<string, Pose>,
): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const [id, pose] of poses) {
    const part = parts.get(id);
    if (!part) continue;

    const ownError = poseDistance(pose, part.targetPose);
    let best: { other: PartDef; d: number } | undefined;

    for (const other of assembly.parts) {
      if (other.id === part.id) continue;
      const d = poseDistance(pose, other.targetPose);
      if (!best || d < best.d) best = { other, d };
    }

    // Only a clear win counts: the part must sit meaningfully nearer someone
    // else's home than its own, otherwise dense assemblies false-positive.
    if (!best || best.d >= ownError * 0.5 || ownError < 0.005) continue;

    const mirrored =
      part.mirrorGroup !== undefined && part.mirrorGroup === best.other.mirrorGroup;

    out.push({
      id: `swap:${id}`,
      code: mirrored ? 'MIRRORED_VARIANT' : 'SWAPPED_PART',
      severity: 'error',
      message: mirrored
        ? `${part.name} is fitted in the ${best.other.name} position — handed parts are swapped.`
        : `${part.name} is sitting where ${best.other.name} belongs.`,
      detail: `${fmtMm(best.d * M_TO_MM)} from ${best.other.name}'s nominal, ${fmtMm(ownError * M_TO_MM)} from its own.`,
      partIds: [part.id, best.other.id],
      fix: mirrored
        ? `Swap ${part.name} and ${best.other.name}. Check the hand stamp before refitting.`
        : `Remove ${part.name} and fit ${best.other.name} here.`,
      magnitude: ownError * M_TO_MM,
    });
  }

  return out;
}

/** A step signed off with parts still missing. */
function missingPartDiagnostics(
  assembly: AssemblyDef,
  poses: Map<string, Pose>,
  completed: Set<string>,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const step of assembly.steps) {
    if (!completed.has(step.id)) continue;
    const missing = step.partIds.filter((id) => !poses.has(id));
    if (missing.length === 0) continue;
    out.push({
      id: `missing:${step.id}`,
      code: 'MISSING_PART',
      severity: 'error',
      message: `"${step.title}" is signed off with ${missing.length} part(s) not fitted.`,
      partIds: missing,
      stepId: step.id,
      fix: 'Fit the remaining parts or re-open the step.',
      magnitude: missing.length,
    });
  }
  return out;
}

/** Highest severity affecting a part, for colouring it in the 3D view. */
export function severityByPart(diagnostics: Diagnostic[]): Map<string, Severity> {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const out = new Map<string, Severity>();
  for (const d of diagnostics) {
    for (const id of d.partIds) {
      const existing = out.get(id);
      if (!existing || rank[d.severity] < rank[existing]) out.set(id, d.severity);
    }
  }
  return out;
}
