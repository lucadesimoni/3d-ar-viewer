import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { ObjectAnchorTracker } from './objectAnchor';
import { detectGridFacade, matchesGridTarget } from './gridRecognition';
import { levelingHomography } from './leveling';
import { estimateIntrinsics } from '../engine/tracking/markerTracking';
import { kallax4x2Assembly } from '../data/kallax';
import type { Pose, Quat } from '../engine/types';

const target = kallax4x2Assembly.recognition!;
const BOARD = 0.03;
/** Face centre of the shelf in the world: a low 4x2 standing on the floor 2.3 m ahead. */
const FACE: [number, number, number] = [0, target.heightM / 2 + BOARD, 2.3];

interface View {
  width: number;
  height: number;
  fovDeg: number;
  eye: [number, number, number];
  rollDeg?: number;
}

/**
 * A camera frame of the shelf, rendered through Babylon's own camera.
 *
 * Every pixel's ray comes from the camera's world matrix and is intersected
 * with the facade plane, so the image is exactly what that camera sees —
 * pitch, roll and all — by a path that shares nothing with `leveling.ts`. A
 * sign wrong in either shows up as a failed lock rather than as two mistakes
 * agreeing with each other.
 */
function frame(v: View) {
  const engine = new NullEngine({ renderWidth: v.width, renderHeight: v.height, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  const camera = new UniversalCamera('cam', new Vector3(...v.eye), scene);
  camera.fov = (v.fovDeg * Math.PI) / 180;
  camera.setTarget(new Vector3(...FACE));
  camera.rotation.z = ((v.rollDeg ?? 0) * Math.PI) / 180;
  camera.computeWorldMatrix();
  const world = camera.getWorldMatrix().clone();
  const K = estimateIntrinsics(v.width, v.height, v.fovDeg);

  const outerW = target.widthM + BOARD;
  const outerH = target.heightM + BOARD;
  const left = FACE[0] - outerW / 2;
  const topY = FACE[1] + outerH / 2;
  const onBoard = (d: number, pitch: number, n: number) => {
    for (let i = 0; i <= n; i++) if (Math.abs(d - (BOARD / 2 + i * pitch)) <= BOARD / 2) return true;
    return false;
  };

  const data = new Uint8ClampedArray(v.width * v.height * 4);
  const dir = new Vector3();
  const origin = Vector3.TransformCoordinates(Vector3.Zero(), world);
  for (let y = 0; y < v.height; y++) {
    for (let x = 0; x < v.width; x++) {
      Vector3.TransformNormalToRef(new Vector3((x - K.cx) / K.fx, -(y - K.cy) / K.fy, 1), world, dir);
      let value = 138;
      const t = (FACE[2] - origin.z) / dir.z;
      if (t > 0) {
        const lx = origin.x + t * dir.x - left;
        const ly = topY - (origin.y + t * dir.y);
        if (lx >= 0 && lx <= outerW && ly >= 0 && ly <= outerH) {
          value = onBoard(lx, target.widthM / target.cols, target.cols) || onBoard(ly, target.heightM / target.rows, target.rows)
            ? 235 : 42;
        }
      }
      const i = (y * v.width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }

  // The same change of basis `SceneManager.cameraToWorld` applies.
  const camRot = Quaternion.FromRotationMatrix(world.getRotationMatrix());
  const cameraToWorld = (pose: Pose): Pose => {
    const p = Vector3.TransformCoordinates(new Vector3(...pose.position), world);
    const q = camRot.multiply(new Quaternion(...pose.rotation));
    return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
  };
  engine.dispose();
  return { image: new ImageData(data, v.width, v.height), cameraToWorld, K, rotation: [camRot.x, camRot.y, camRot.z, camRot.w] as Quat };
}

/** Three detections, as acquisition needs; the lock's error against the true face centre. */
function acquire(v: View, useGravity = true) {
  const f = frame(v);
  const tracker = new ObjectAnchorTracker(target, { detectIntervalMs: 400, fovDeg: v.fovDeg });
  const toWorld = useGravity ? f.cameraToWorld : undefined;
  let obs;
  for (let n = 0; n < 3; n++) obs = tracker.update(f.image, n * 500, v.fovDeg, toWorld);
  if (!obs) return { locked: false as const, f };
  const at = f.cameraToWorld(obs.pose).position;
  const range = Math.hypot(FACE[0] - v.eye[0], FACE[1] - v.eye[1], FACE[2] - v.eye[2]);
  const errorM = Math.hypot(at[0] - FACE[0], at[1] - FACE[1], at[2] - FACE[2]);
  return { locked: true as const, errorM, range, f };
}

describe('leveling a tipped camera before looking for the shelf', () => {
  it('is the identity for a level camera, and knows when it is tipped', () => {
    const { K } = frame({ width: 480, height: 800, fovDeg: 72, eye: [0, FACE[1], 0] });
    expect(levelingHomography([0, 0, 0, 1], K)!.tiltDeg).toBeCloseTo(0, 6);
    const tipped = frame({ width: 480, height: 800, fovDeg: 72, eye: [0, 1.7, 0], rollDeg: 20 });
    expect(levelingHomography(tipped.rotation, tipped.K)!.tiltDeg).toBeGreaterThan(30);
  });

  // Measured before this was built: the plain detector still matched a shelf
  // seen from 20-35 degrees above, but its rectangle is the wrong shape for a
  // trapezoid and the pose was 3-11% of the range out (7.6% at 30 degrees);
  // with the phone rolled 25 degrees it matched at 127% out, and from more
  // than about 15 degrees to the side it found nothing at all. Leveled by
  // gravity, turned square-on by the boards' own vanishing point, and with the
  // lines measured at full resolution, every one of these is within 0.35%.
  const drop = (deg: number) => Math.tan((deg * Math.PI) / 180) * FACE[2];
  const side = (deg: number) => Math.tan((deg * Math.PI) / 180) * FACE[2];
  const views: [string, View][] = [
    ['looking down 30 degrees at a low shelf', { width: 480, height: 800, fovDeg: 72, eye: [0, FACE[1] + drop(30), 0] }],
    ['looking down 40 degrees, past where the plain detector gives up', { width: 480, height: 800, fovDeg: 72, eye: [0, FACE[1] + drop(40), 0] }],
    ['the phone rolled 25 degrees, held level otherwise', { width: 480, height: 800, fovDeg: 72, eye: [0, FACE[1], 0], rollDeg: 25 }],
    ['looking down with the phone rolled 25 degrees', { width: 480, height: 800, fovDeg: 72, eye: [0, FACE[1] + drop(20), 0], rollDeg: 25 }],
    ['an iPad in landscape, looking down 25 degrees', { width: 800, height: 600, fovDeg: 50, eye: [0, FACE[1] + drop(25), 0] }],
    ['standing 21 degrees off to the side', { width: 480, height: 800, fovDeg: 72, eye: [side(21), FACE[1] + drop(25), 0] }],
    ['an iPad 35 degrees off to the other side', { width: 800, height: 600, fovDeg: 50, eye: [-side(35), FACE[1] + drop(25), 0] }],
  ];

  for (const [name, view] of views) {
    it(`${name}: locks within half a per cent of the range`, () => {
      const got = acquire(view);
      expect(got.locked).toBe(true);
      if (got.locked) expect(got.errorM / got.range).toBeLessThan(0.005);
    });
  }

  it('a square-on view is found by the plain detector, just as precisely', () => {
    const view: View = { width: 480, height: 800, fovDeg: 72, eye: [0, FACE[1], 0] };
    const plain = detectGridFacade(frame(view).image, { target });
    expect(plain && matchesGridTarget(plain, target)).toBe(true);
    const got = acquire(view);
    expect(got.locked).toBe(true);
    if (got.locked) expect(got.errorM / got.range).toBeLessThan(0.005);
  });
});
