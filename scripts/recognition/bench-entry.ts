/**
 * The recognition benchmark, in the browser: renders a view with the presence
 * model's synthetic renderer (`../presence/synth-entry.ts`, bench mode), where
 * the assembly's true pose is known, and measures what the app's recognition
 * makes of it. Driven by `bench.mjs`.
 *
 * Two things are measured:
 *  - registration (`src/perception/register.ts`), from starts a known
 *    distance and angle off the truth, as an anchor placed by a tap or by
 *    WebXR is off;
 *  - for assemblies with a recognition target, the grid detector
 *    (`src/vision/objectAnchor.ts`) from nothing, and registration from its lock.
 */
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { Quaternion as BQuaternion, Vector3 as BVector3 } from '@babylonjs/core/Maths/math.vector';
import { Quaternion, Vector3 } from 'three';
import { ASSEMBLIES } from '../../src/data';
import type { Pose } from '../../src/engine/types';
import { alignToMarker } from '../../src/engine/alignment';
import { cameraIntrinsics } from '../../src/perception/intrinsics';
import { displacementPx, edgeModel, gradientPyramid, projectedEdges, registerPose, type RegistrationResult } from '../../src/perception/register';
import { ObjectAnchorTracker } from '../../src/vision/objectAnchor';
import { render, type BenchView } from '../presence/synth-entry';

const IDENTITY: Pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

/**
 * How far a pose is from the truth (the identity): metres across the floor,
 * and degrees of turn. Height is left out: in floor mode it is the platform's
 * floor, which registration does not move.
 */
function poseError(p: Pose): { m: number; deg: number } {
  const q = new Quaternion(...p.rotation);
  return { m: Math.hypot(p.position[0], p.position[2]), deg: (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI };
}

/** A start this far off the truth: across the floor at `bearing`, turned by `yawDeg`, and a little off in height, as a measured floor is. */
function offset(m: number, bearingDeg: number, yawDeg: number, dy: number): Pose {
  const b = (bearingDeg * Math.PI) / 180;
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180);
  return { position: [Math.cos(b) * m, dy, Math.sin(b) * m], rotation: [q.x, q.y, q.z, q.w] };
}

export interface Trial {
  start: string;
  before: { m: number; deg: number };
  after: { m: number; deg: number };
  /** Mean distance in the image, pixels, between the model's edges at the truth and at the start, and at the result: what the operator sees. */
  beforePx: number;
  afterPx: number;
  result: Pick<RegistrationResult, 'accepted' | 'reason' | 'before' | 'after' | 'visible' | 'rival' | 'weakest'>;
  ms: number;
}

export interface BenchResult {
  frame: { width: number; height: number; rgba?: string };
  /** With `keepFrame`: where the model's edges fall at the truth, and at each trial's result. */
  outlines?: { truth: { u: number; v: number }[]; trials: { u: number; v: number }[][] };
  trials: Trial[];
  grid?: { outcome: string; locked: boolean; error?: { m: number; deg: number } };
}

async function run(opts: { seed: number; width: number; height: number; bench: BenchView; starts: [number, number, number, number][]; keepFrame?: boolean; workingSize?: number }): Promise<BenchResult> {
  const frame = await render({ seed: opts.seed, width: opts.width, height: opts.height, bench: opts.bench });
  const bin = atob(frame.rgba); const data = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const image = new ImageData(data, frame.width, frame.height);
  const k = cameraIntrinsics({ frame: image, operatorFovDeg: frame.fovDeg });
  const assembly = ASSEMBLIES.find((a) => a.id === opts.bench.assemblyId)!;
  const model = edgeModel(assembly);
  const field = gradientPyramid(image, opts.workingSize);
  const outlines = {
    truth: opts.keepFrame ? projectedEdges(IDENTITY, { model, viewMatrix: frame.view, cameraPosition: frame.cameraPosition, k }) : [],
    trials: [] as { u: number; v: number }[][],
  };
  const register = (start: Pose, label: string): Trial => {
    const t0 = performance.now();
    const result = registerPose({ field, model, start, viewMatrix: frame.view, cameraPosition: frame.cameraPosition, k });
    const ms = performance.now() - t0;
    const { pose: _pose, ...rest } = result;
    if (opts.keepFrame) outlines.trials.push(projectedEdges(result.pose, { model, viewMatrix: frame.view, cameraPosition: frame.cameraPosition, k }));
    const cam = { model, viewMatrix: frame.view, cameraPosition: frame.cameraPosition, k };
    return {
      start: label, before: poseError(start), after: poseError(result.accepted ? result.pose : start),
      beforePx: displacementPx(IDENTITY, start, cam), afterPx: displacementPx(IDENTITY, result.accepted ? result.pose : start, cam),
      result: rest, ms,
    };
  };

  const trials = opts.starts.map(([m, bearing, yaw, dy]) => register(offset(m, bearing, yaw, dy), `${m * 100}cm@${bearing}° ${yaw}°`));

  let grid: BenchResult['grid'];
  const target = assembly.recognition;
  if (target) {
    const camera = Matrix.FromArray(frame.view).invert();
    const camRot = BQuaternion.FromRotationMatrix(camera.getRotationMatrix());
    const toWorld = (pose: Pose): Pose => {
      const p = BVector3.TransformCoordinates(new BVector3(...pose.position), camera);
      const q = camRot.multiply(new BQuaternion(...pose.rotation));
      return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
    };
    const tracker = new ObjectAnchorTracker(target, { detectIntervalMs: 1 });
    let obs;
    for (let t = 0; t < 12 && !(obs && tracker.hasLock); t++) obs = tracker.update(image, t * 100, k.fovDeg, toWorld) ?? obs;
    if (obs && tracker.hasLock) {
      const anchor = alignToMarker(toWorld(obs.pose), target.poseInAssembly);
      grid = { outcome: 'locked', locked: true, error: poseError(anchor) };
      trials.push(register(anchor, 'grid lock'));
    } else {
      grid = { outcome: tracker.lastAttempt?.outcome ?? 'none', locked: false };
    }
  }
  return {
    frame: { width: frame.width, height: frame.height, ...(opts.keepFrame ? { rgba: frame.rgba } : {}) },
    trials, grid, ...(opts.keepFrame ? { outlines } : {}),
  };
}

(window as unknown as { bench: { run: typeof run; identity: Pose } }).bench = { run, identity: IDENTITY };
