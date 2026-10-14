import { describe, expect, it } from 'vitest';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { nativeCameraToBabylon } from './pose';
import type { Pose } from '../engine/types';

/** Where a native world point lands in the Babylon camera's view: x right, y up, z ahead. */
function inView(nativeCamera: Pose, nativePoint: [number, number, number]): Vector3 {
  const cam = nativeCameraToBabylon(nativeCamera);
  const world = Matrix.Compose(Vector3.One(), new Quaternion(...cam.rotation), new Vector3(...cam.position));
  const point = new Vector3(-nativePoint[0], nativePoint[1], nativePoint[2]);
  return Vector3.TransformCoordinates(point, world.invert());
}

/** A native (right-handed) rotation of `deg` about `axis`. */
const about = (axis: [number, number, number], deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 360; const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
};

describe('a native camera pose in the renderer', () => {
  const origin: Pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

  it('sees ahead what is ahead, right what is right, up what is up', () => {
    // The native camera looks down -z: a point 2 m down -z, 1 m right, 0.5 m up.
    const v = inView(origin, [1, 0.5, -2]);
    expect(v.z).toBeCloseTo(2);
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(0.5);
  });

  it('turning the phone left brings what was on the left to the middle', () => {
    // Turn left = positive rotation about +y in a right-handed world.
    const turned: Pose = { position: [0, 0, 0], rotation: about([0, 1, 0], 90) };
    const v = inView(turned, [-2, 0, 0]);
    expect(v.z).toBeCloseTo(2);
    expect(v.x).toBeCloseTo(0);
  });

  it('tilting the phone down brings the floor into view', () => {
    const down: Pose = { position: [0, 1.4, 0], rotation: about([1, 0, 0], -90) };
    const v = inView(down, [0, 0, 0]);
    expect(v.z).toBeCloseTo(1.4);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(0);
  });

  it('walking forward brings the object nearer: position follows the phone', () => {
    const walked: Pose = { position: [0, 0, -1], rotation: [0, 0, 0, 1] };
    expect(inView(walked, [0, 0, -3]).z).toBeCloseTo(2);
    const stepped: Pose = { position: [0.5, 0, 0], rotation: [0, 0, 0, 1] };
    expect(inView(stepped, [0, 0, -2]).x).toBeCloseTo(-0.5);
  });
});
