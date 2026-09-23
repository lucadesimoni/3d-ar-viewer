import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Vector3 as BVector3 } from '@babylonjs/core/Maths/math.vector';
import { Vector3 } from 'three';
import { cameraIntrinsics } from './intrinsics';
import { edgeField } from './edges';
import { projectToImage, toViewSpace } from './roi';
import { readPresence, type PartBox } from './presence';

const W = 480;
const H = 640;

function camera() {
  const engine = new NullEngine({ renderWidth: W, renderHeight: H, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  const cam = new UniversalCamera('cam', new BVector3(0, 0, 0), scene);
  cam.fov = (60 * Math.PI) / 180;
  cam.minZ = 0.05;
  scene.activeCamera = cam;
  cam.setTarget(new BVector3(0, 0, 1));
  scene.updateTransformMatrix();
  const view = scene.getViewMatrix().asArray();
  engine.dispose();
  return { view, k: cameraIntrinsics({ frame: { width: W, height: H }, xrFovDeg: 60 }) };
}

/** A board facing the camera, 60 x 40 cm, two metres ahead. */
const board: PartBox = { center: [0, 0, 2], halfExtents: [0.3, 0.2, 0.01], rotation: [0, 0, 0, 1] };

/** Draw where the board projects to, optionally shifted, on a mid-grey wall. */
function frame(draw: boolean, shiftPx = 0): ImageData {
  const { view, k } = camera();
  const corners = [[-0.3, -0.2], [0.3, 0.2]].map(([x, y]) =>
    projectToImage(toViewSpace(new Vector3(x, y, 2 - 0.01), view), k));
  const x0 = Math.min(corners[0].u, corners[1].u) + shiftPx;
  const x1 = Math.max(corners[0].u, corners[1].u) + shiftPx;
  const y0 = Math.min(corners[0].v, corners[1].v);
  const y1 = Math.max(corners[0].v, corners[1].v);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const on = draw && x >= x0 && x < x1 && y >= y0 && y < y1;
      const i = (y * W + x) * 4;
      // A little texture everywhere, so the wall is not a blank frame.
      const v = on ? 225 : 110 + ((x * 7 + y * 13) % 9);
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, W, H);
}

const fair = { hasTarget: true, anchored: true, sharp: true, trackingReady: true, explodeFactor: 0, occluded: false, frameUniform: false };

describe('is this part really there?', () => {
  it('votes present when the image has the part where the model puts it', () => {
    const { view, k } = camera();
    const r = readPresence({ field: edgeField(frame(true)), box: board, viewMatrix: view, k, gates: fair });
    expect(r.eligibility.eligible).toBe(true);
    expect(r.vote).toEqual({ present: true });
  });

  it('still votes present when the anchor is a few pixels out', () => {
    const { view, k } = camera();
    const r = readPresence({ field: edgeField(frame(true, 6)), box: board, viewMatrix: view, k, gates: fair });
    expect(r.vote).toEqual({ present: true });
  });

  it('votes absent when the part is not in the picture', () => {
    const { view, k } = camera();
    const r = readPresence({ field: edgeField(frame(false)), box: board, viewMatrix: view, k, gates: fair });
    expect(r.vote).toEqual({ present: false });
  });

  it('casts no vote at all when asking is not fair — never "absent" for a blurry frame', () => {
    const { view, k } = camera();
    const r = readPresence({ field: edgeField(frame(false)), box: board, viewMatrix: view, k, gates: { ...fair, sharp: false } });
    expect(r.vote).toBeUndefined();
    expect(r.eligibility.reasons).toContain('blurry');
  });

  it('casts no vote for a part that is only half in the frame', () => {
    const { view, k } = camera();
    const half: PartBox = { ...board, center: [1.4, 0, 2] };
    const r = readPresence({ field: edgeField(frame(false)), box: half, viewMatrix: view, k, gates: fair });
    expect(r.vote).toBeUndefined();
    expect(r.eligibility.reasons).toContain('clipped');
  });
});
