import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Matrix, Vector3 as BVector3 } from '@babylonjs/core/Maths/math.vector';
import { cameraIntrinsics } from './intrinsics';
import { obbCorners, projectToImage, roiForObb, toViewSpace } from './roi';
import type { Obb } from '../engine/collision';

const WIDTH = 480;
const HEIGHT = 640;
const FOV_DEG = 72.18;

const box = (center: [number, number, number], half = 0.1): Obb => ({
  center: new Vector3(...center),
  halfExtents: new Vector3(half, half, half),
  rotation: new Quaternion(),
});

/** A camera at the origin looking down +Z, in Babylon's own left-handed frame. */
function babylonCamera(position: [number, number, number] = [0, 0, 0]) {
  const engine = new NullEngine({ renderWidth: WIDTH, renderHeight: HEIGHT, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  const camera = new UniversalCamera('cam', new BVector3(...position), scene);
  camera.fov = (FOV_DEG * Math.PI) / 180;
  camera.minZ = 0.05;
  scene.activeCamera = camera;
  camera.setTarget(new BVector3(position[0], position[1], position[2] + 1));
  scene.updateTransformMatrix();
  return { engine, scene, camera };
}

describe('projecting geometry into the camera image', () => {
  it('agrees with the renderer, to a pixel', () => {
    // The strongest check this repo knows, and the one that settled the field
    // of view: two paths that share no code, arriving at the same number. If a
    // handedness or a sign is wrong here, it is wrong on the bench too — and
    // there it looks like a detector that cannot find a part that is in plain
    // view. `Vector3.Project` is Babylon's own; `projectToImage` is the
    // pinhole model with the measured intrinsics.
    const { engine, scene, camera } = babylonCamera();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });
    const viewMatrix = scene.getViewMatrix().asArray();

    for (const p of [
      [0, 0, 2], [0.3, 0.2, 1.5], [-0.4, -0.25, 1.2], [0.1, -0.6, 3], [-0.9, 0.7, 4],
    ] as [number, number, number][]) {
      const ours = projectToImage(toViewSpace(new Vector3(...p), viewMatrix), k);
      const theirs = BVector3.Project(
        new BVector3(...p),
        Matrix.Identity(),
        scene.getTransformMatrix(),
        camera.viewport.toGlobal(WIDTH, HEIGHT),
      );
      expect(ours.u).toBeCloseTo(theirs.x, 0);
      expect(ours.v).toBeCloseTo(theirs.y, 0);
    }
    engine.dispose();
  });

  it('puts what is straight ahead in the middle, and the rest where it belongs', () => {
    const { engine, scene } = babylonCamera();
    const view = scene.getViewMatrix().asArray();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });

    const ahead = roiForObb(box([0, 0, 2]), view, k)!;
    expect(ahead.rect.x + ahead.rect.w / 2).toBeCloseTo(WIDTH / 2, 1);
    expect(ahead.rect.y + ahead.rect.h / 2).toBeCloseTo(HEIGHT / 2, 1);

    // To the operator's right is right of centre; higher up is higher in frame,
    // which in an image means a *smaller* row number.
    const right = roiForObb(box([0.5, 0, 2]), view, k)!;
    expect(right.rect.x).toBeGreaterThan(ahead.rect.x);
    const above = roiForObb(box([0, 0.5, 2]), view, k)!;
    expect(above.rect.y).toBeLessThan(ahead.rect.y);
    engine.dispose();
  });

  it('says nothing at all about what is behind the camera', () => {
    const { engine, scene } = babylonCamera();
    const view = scene.getViewMatrix().asArray();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });
    // Not a mirrored rectangle somewhere confidently wrong: no answer.
    expect(roiForObb(box([0, 0, -2]), view, k)).toBeUndefined();
    // Nor for something in front but entirely off to the side.
    expect(roiForObb(box([12, 0, 1]), view, k)).toBeUndefined();
    engine.dispose();
  });

  it('marks a region it can only partly see', () => {
    const { engine, scene } = babylonCamera();
    const view = scene.getViewMatrix().asArray();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });

    // A region that is only partly in frame must never be allowed to say a
    // part is missing — the missing evidence is outside the picture.
    expect(roiForObb(box([0, 0, 2]), view, k)!.clipped).toBe(false);
    const straddling = roiForObb(box([0, 0, 0.1], 0.5), view, k)!;
    expect(straddling.clipped).toBe(true);
    const edge = roiForObb(box([1.3, 0, 1]), view, k);
    if (edge) expect(edge.clipped).toBe(true);
    engine.dispose();
  });

  it('gets smaller with distance, and stays inside the frame', () => {
    const { engine, scene } = babylonCamera();
    const view = scene.getViewMatrix().asArray();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });

    const near = roiForObb(box([0, 0, 1]), view, k)!;
    const far = roiForObb(box([0, 0, 4]), view, k)!;
    expect(far.areaFraction).toBeLessThan(near.areaFraction);
    // Four times the distance is about a sixteenth of the area.
    expect(near.areaFraction / far.areaFraction).toBeGreaterThan(9);
    expect(far.distanceM).toBeGreaterThan(near.distanceM);
    for (const roi of [near, far]) {
      expect(roi.rect.x).toBeGreaterThanOrEqual(0);
      expect(roi.rect.y).toBeGreaterThanOrEqual(0);
      expect(roi.rect.x + roi.rect.w).toBeLessThanOrEqual(WIDTH);
      expect(roi.rect.y + roi.rect.h).toBeLessThanOrEqual(HEIGHT);
    }
    engine.dispose();
  });

  it('pads the rectangle by a share of its own size, for pose error', () => {
    const { engine, scene } = babylonCamera();
    const view = scene.getViewMatrix().asArray();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });
    const plain = roiForObb(box([0, 0, 2]), view, k)!;
    const padded = roiForObb(box([0, 0, 2]), view, k, { padding: 0.5 })!;
    expect(padded.rect.w).toBeCloseTo(plain.rect.w * 1.5, 3);
    expect(padded.rect.x + padded.rect.w / 2).toBeCloseTo(plain.rect.x + plain.rect.w / 2, 3);
    engine.dispose();
  });

  it('turns a box with the box, rather than around the world axes', () => {
    // A world-axis-aligned bound on a turned part is the diamond that made the
    // ground outline wrong once already; the corners come from the box's own
    // basis so a 45-degree part gets a wider rectangle, not a rotated one.
    const turned: Obb = {
      center: new Vector3(0, 0, 2),
      halfExtents: new Vector3(0.4, 0.05, 0.05),
      rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4),
    };
    const corners = obbCorners(turned);
    expect(corners).toHaveLength(8);
    const spanX = Math.max(...corners.map((c) => c.x)) - Math.min(...corners.map((c) => c.x));
    const spanZ = Math.max(...corners.map((c) => c.z)) - Math.min(...corners.map((c) => c.z));
    expect(spanX).toBeCloseTo(spanZ, 3);
    expect(spanX).toBeCloseTo(2 * (0.4 + 0.05) * Math.SQRT1_2, 3);
  });
});
