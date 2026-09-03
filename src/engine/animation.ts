import { Quaternion, Vector3 } from 'three';
import { clamp, q4, toQuat, toVec3, v3 } from './math';
import { topoOrder } from './sequencer';
import type { AssemblyDef, PartDef, Pose, StepDef, Vec3 } from './types';

export type Easing = (t: number) => number;

export const easeLinear: Easing = (t) => t;
export const easeInOutCubic: Easing = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - t, 3);
/** Slight overshoot then settle — reads as a part being pressed home. */
export const easeOutBack: Easing = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export interface Keyframe {
  /** Seconds from the start of the timeline. */
  t: number;
  pose: Pose;
  easing?: Easing;
}

export interface PartTrack {
  partId: string;
  keyframes: Keyframe[];
}

export interface Timeline {
  durationS: number;
  tracks: PartTrack[];
  /** Marks where each step begins, for the scrubber's tick labels. */
  markers: { t: number; stepId: string; title: string }[];
}

const DEFAULT_APPROACH: Vec3 = [0, 1, 0];

/** Where a part waits before it is installed: offset along its approach vector. */
export function stagedPose(part: PartDef, standoffM = 0.12): Pose {
  const dir = v3(part.approach ?? DEFAULT_APPROACH).normalize();
  const p = v3(part.targetPose.position).add(dir.multiplyScalar(standoffM));
  return { position: toVec3(p), rotation: [...part.targetPose.rotation] as Pose['rotation'] };
}

/**
 * Animation for a single step: every part of the step flies in from its standoff
 * position, staggered so the operator can see the order within the step.
 */
export function stepTimeline(
  assembly: AssemblyDef,
  step: StepDef,
  opts: { perPartS?: number; staggerS?: number; standoffM?: number } = {},
): Timeline {
  const perPartS = opts.perPartS ?? 1.2;
  const staggerS = opts.staggerS ?? 0.35;
  const standoff = opts.standoffM ?? 0.12;
  const byId = new Map(assembly.parts.map((p) => [p.id, p]));

  const tracks: PartTrack[] = [];
  step.partIds.forEach((partId, i) => {
    const part = byId.get(partId);
    if (!part) return;
    const start = i * staggerS;
    tracks.push({
      partId,
      keyframes: [
        { t: 0, pose: stagedPose(part, standoff) },
        { t: start, pose: stagedPose(part, standoff), easing: easeInOutCubic },
        { t: start + perPartS, pose: part.targetPose, easing: easeOutBack },
      ],
    });
  });

  const durationS = Math.max(perPartS, (step.partIds.length - 1) * staggerS + perPartS);
  return { durationS, tracks, markers: [{ t: 0, stepId: step.id, title: step.title }] };
}

/**
 * Full-build playback in dependency order.
 *
 * Parts that belong to later steps sit at their standoff position until their
 * step comes up, so the whole sequence reads as one continuous build rather
 * than parts popping into existence.
 */
export function assemblyTimeline(
  assembly: AssemblyDef,
  opts: { stepS?: number; standoffM?: number } = {},
): Timeline {
  const stepS = opts.stepS ?? 1.6;
  const standoff = opts.standoffM ?? 0.12;
  const order = topoOrder(assembly.steps) ?? assembly.steps.map((s) => s.id);
  const stepsById = new Map(assembly.steps.map((s) => [s.id, s]));
  const partsById = new Map(assembly.parts.map((p) => [p.id, p]));

  const tracks: PartTrack[] = [];
  const markers: Timeline['markers'] = [];
  let cursor = 0;

  for (const stepId of order) {
    const step = stepsById.get(stepId);
    if (!step) continue;
    markers.push({ t: cursor, stepId, title: step.title });

    for (const partId of step.partIds) {
      const part = partsById.get(partId);
      if (!part) continue;
      const staged = stagedPose(part, standoff);
      tracks.push({
        partId,
        keyframes: [
          { t: 0, pose: staged },
          { t: cursor, pose: staged, easing: easeInOutCubic },
          { t: cursor + stepS, pose: part.targetPose, easing: easeOutBack },
        ],
      });
    }
    cursor += stepS;
  }

  return { durationS: Math.max(cursor, stepS), tracks, markers };
}

/** Pose of one track at time `t`, clamped at both ends. */
export function samplePose(track: PartTrack, t: number): Pose {
  const kf = track.keyframes;
  if (kf.length === 0) return { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
  if (t <= kf[0].t) return kf[0].pose;
  const last = kf[kf.length - 1];
  if (t >= last.t) return last.pose;

  let i = 0;
  while (i < kf.length - 1 && kf[i + 1].t <= t) i++;
  const a = kf[i];
  const b = kf[i + 1];
  const span = b.t - a.t;
  const raw = span <= 1e-6 ? 1 : (t - a.t) / span;
  const eased = clamp((b.easing ?? easeInOutCubic)(clamp(raw, 0, 1)), -0.5, 1.5);

  const pos = v3(a.pose.position).lerp(v3(b.pose.position), eased);
  // Rotation always uses the un-overshot parameter: a rotational overshoot on a
  // keyed part looks like a fault, not a flourish.
  const rot = q4(a.pose.rotation).clone().slerp(q4(b.pose.rotation), clamp(raw, 0, 1));
  return { position: toVec3(pos), rotation: toQuat(rot) };
}

/** All part poses at time `t`. */
export function sampleTimeline(timeline: Timeline, t: number): Map<string, Pose> {
  const out = new Map<string, Pose>();
  for (const track of timeline.tracks) out.set(track.partId, samplePose(track, t));
  return out;
}

/** Centroid of every part's nominal position — the pivot for the exploded view. */
export function assemblyCentroid(assembly: AssemblyDef): Vector3 {
  const c = new Vector3();
  if (assembly.parts.length === 0) return c;
  for (const p of assembly.parts) c.add(v3(p.targetPose.position));
  return c.divideScalar(assembly.parts.length);
}

/**
 * Exploded view: push each part away from the centroid.
 *
 * `factor` 0 is the assembled state, 1 spreads parts by roughly their own
 * distance from the centre again. Parts sitting exactly at the centroid get
 * pushed along their approach vector so they do not stay buried.
 */
export function explodePose(
  part: PartDef,
  centroid: Vector3,
  factor: number,
  pose: Pose = part.targetPose,
): Pose {
  if (factor <= 0) return pose;
  const from = v3(pose.position);
  let dir = from.clone().sub(centroid);
  if (dir.lengthSq() < 1e-6) dir = v3(part.approach ?? DEFAULT_APPROACH).normalize().multiplyScalar(0.05);
  const moved = from.add(dir.multiplyScalar(factor));
  return { position: toVec3(moved), rotation: pose.rotation };
}

/**
 * Attention pulse for a part flagged by diagnostics: a small oscillation about
 * the current pose, so the eye lands on it in a dense assembly.
 */
export function pulseScale(timeMs: number, hz = 1.6, amplitude = 0.04): number {
  return 1 + Math.sin((timeMs / 1000) * hz * Math.PI * 2) * amplitude;
}

/** Quaternion for spinning a part about its own axis — used on fastener hints. */
export function spinAbout(axis: Vec3, radians: number): Quaternion {
  return new Quaternion().setFromAxisAngle(v3(axis).normalize(), radians);
}
