import type { Pose } from '../engine/types';

/**
 * A native AR camera pose, in the renderer's frame.
 *
 * ARCore and ARKit both report a right-handed world, y up, with the camera
 * looking down its own -z: WebXR's and three.js's convention. Babylon is
 * left-handed and its camera looks down +z. The app already maps a three-style
 * camera *orientation* into Babylon in `SceneManager.setDeviceOrientation`
 * (mirror in x, then a half turn about y), pinned by `deviceOrientation.test.ts`.
 * The same change of basis applies to a native pose; as a single matrix that is
 * a mirror in x for world points. So positions take (-x, y, z), and the
 * rotation is that same orientation mapping. One rule, so the overlay and the
 * world turn together.
 */
export function nativeCameraToBabylon(pose: Pose): Pose {
  const [x, y, z] = pose.position;
  const [qx, qy, qz, qw] = pose.rotation;
  // (qx, -qy, -qz, qw) × half turn about y, which is (0, 1, 0, 0).
  const ax = qx; const ay = -qy; const az = -qz; const aw = qw;
  return {
    position: [-x, y, z],
    rotation: [
      aw * 0 + ax * 0 + ay * 0 - az * 1,
      aw * 1 - ax * 0 + ay * 0 + az * 0,
      aw * 0 + ax * 1 - ay * 0 + az * 0,
      aw * 0 - ax * 0 - ay * 1 - az * 0,
    ],
  };
}

/** A native world height, in the renderer's frame: heights do not change. */
export const nativeYToBabylon = (y: number): number => y;
