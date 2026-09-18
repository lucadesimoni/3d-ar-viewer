import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Vector3 as BVector3 } from '@babylonjs/core/Maths/math.vector';
import { cameraIntrinsics } from './intrinsics';
import { partContour } from './contour';
import type { Obb } from '../engine/collision';

const WIDTH = 480;
const HEIGHT = 640;
const FOV_DEG = 72.18;

/** Same rig as `roi.test.ts`: a camera at the origin looking down +Z. */
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

const box = (center: [number, number, number], half: [number, number, number], rotation = new Quaternion()): Obb => ({
  center: new Vector3(...center),
  halfExtents: new Vector3(...half),
  rotation,
});

function isConvex(hull: { x: number; y: number }[]): boolean {
  if (hull.length < 3) return true;
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const c = hull[(i + 2) % hull.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

describe('a part\'s own contour', () => {
  it('is a rectangle when the box faces the camera straight on', () => {
    const { engine, scene } = babylonCamera();
    const view = scene.getViewMatrix().asArray();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });
    const c = partContour(box([0, 0, 2], [0.3, 0.2, 0.15]), view, k);
    expect(c).toBeDefined();
    expect(c!.hull).toHaveLength(4);
    expect(c!.droppedCorners).toBe(0);
    expect(isConvex(c!.hull)).toBe(true);
    engine.dispose();
  });

  it('gains corners once three faces come into view, up to six', () => {
    // A box turned corner-on to the camera shows its top, front and side face
    // at once — the classic hexagonal silhouette of a cube seen from a corner.
    const { engine, scene } = babylonCamera();
    const view = scene.getViewMatrix().asArray();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });
    const rotation = new Quaternion()
      .setFromAxisAngle(new Vector3(1, 0, 0), (20 * Math.PI) / 180)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (20 * Math.PI) / 180));
    const c = partContour(box([0, 0, 2], [0.3, 0.2, 0.15], rotation), view, k);
    expect(c).toBeDefined();
    expect(c!.hull.length).toBeGreaterThanOrEqual(5);
    expect(c!.hull.length).toBeLessThanOrEqual(6);
    expect(c!.droppedCorners).toBe(0);
    expect(isConvex(c!.hull)).toBe(true);
    engine.dispose();
  });

  it('drops corners that fall behind the near plane and says how many', () => {
    // Pulled in close enough that some, but not all, of the box's eight
    // corners cross the near-plane guard (`roi.ts`'s own `NEAR_M`) — the same
    // rule `roiForObb` applies to its rectangle, so a part right at the
    // camera does not get mirrored through the lens into a confident lie.
    const { engine, scene } = babylonCamera();
    const view = scene.getViewMatrix().asArray();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });
    const rotation = new Quaternion()
      .setFromAxisAngle(new Vector3(1, 0, 0), (12 * Math.PI) / 180)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (37 * Math.PI) / 180));
    const c = partContour(box([0, 0, 0.18], [0.3, 0.2, 0.15], rotation), view, k);
    expect(c).toBeDefined();
    expect(c!.droppedCorners).toBeGreaterThan(0);
    expect(c!.droppedCorners).toBeLessThan(8);
    expect(c!.hull.length).toBeGreaterThanOrEqual(3);
    expect(isConvex(c!.hull)).toBe(true);
    engine.dispose();
  });

  it('says nothing when the whole box is behind the camera', () => {
    const { engine, scene } = babylonCamera();
    const view = scene.getViewMatrix().asArray();
    const k = cameraIntrinsics({ frame: { width: WIDTH, height: HEIGHT }, xrFovDeg: FOV_DEG });
    const c = partContour(box([0, 0, -2], [0.3, 0.2, 0.15]), view, k);
    expect(c).toBeUndefined();
    engine.dispose();
  });
});
