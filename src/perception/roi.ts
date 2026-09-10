import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Obb } from '../engine/collision';
import type { CameraIntrinsics } from './intrinsics';

/**
 * Where in the camera image a part *should* be, according to the geometry.
 *
 * This is the idea the architecture analysis got most right: a model looking at
 * the whole bench has the whole bench to be wrong about. The app already knows
 * where every part is meant to sit — it draws them — so it can hand the camera
 * a rectangle instead of a room. That both speeds inference up and removes the
 * false detections that come from the clutter around the work.
 *
 * It only became honest with `intrinsics.ts`: a rectangle projected through a
 * focal length that is twenty per cent wrong points at the wrong part of the
 * bench. The measurement came first for a reason.
 *
 * No renderer here. The camera arrives as the view matrix the renderer already
 * computed — its own truth about where it is looking, rather than a second
 * hand-derived opinion about handedness. That derivation has been wrong in this
 * repo before (`cvPoseToRenderer`, and the mirrored device orientation), and a
 * test pins this one against Babylon's own projection to a pixel.
 */

/** An axis-aligned rectangle in image pixels. */
export interface ImageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PartRoi {
  rect: ImageRect;
  /** Share of the image the part is expected to fill, 0..1. */
  areaFraction: number;
  /** Metres from the camera to the nearest corner of the box. */
  distanceM: number;
  /** Part of the box is behind the camera or outside the frame. */
  clipped: boolean;
}

/**
 * A world point in the camera's own frame, using the renderer's view matrix.
 *
 * Babylon's matrices are row-major with the translation in elements 12..14 and
 * are applied to row vectors, which is what `Vector3.TransformCoordinates`
 * does. The same sixteen numbers, multiplied the same way, without importing
 * the renderer to do it.
 */
export function toViewSpace(world: Vector3, viewMatrix: ArrayLike<number>): Vector3 {
  const m = viewMatrix;
  return new Vector3(
    world.x * m[0] + world.y * m[4] + world.z * m[8] + m[12],
    world.x * m[1] + world.y * m[5] + world.z * m[9] + m[13],
    world.x * m[2] + world.y * m[6] + world.z * m[10] + m[14],
  );
}

/**
 * A point in the camera's frame, as image pixels.
 *
 * The pinhole model, and the one sign that matters: view space has y upwards,
 * an image counts rows downwards.
 */
export function projectToImage(view: Vector3, k: CameraIntrinsics): { u: number; v: number } {
  return {
    u: k.cx + (k.fx * view.x) / view.z,
    v: k.cy - (k.fy * view.y) / view.z,
  };
}

/** The eight corners of an oriented box, in world space. */
export function obbCorners(obb: Obb): Vector3[] {
  const basis = new Matrix4().makeRotationFromQuaternion(obb.rotation);
  const e = basis.elements;
  const axes = [
    new Vector3(e[0], e[1], e[2]).multiplyScalar(obb.halfExtents.x),
    new Vector3(e[4], e[5], e[6]).multiplyScalar(obb.halfExtents.y),
    new Vector3(e[8], e[9], e[10]).multiplyScalar(obb.halfExtents.z),
  ];
  const corners: Vector3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push(new Vector3()
          .copy(obb.center)
          .addScaledVector(axes[0], sx)
          .addScaledVector(axes[1], sy)
          .addScaledVector(axes[2], sz));
      }
    }
  }
  return corners;
}

/** Closer than this to the camera plane, a projection is a division by nothing. */
const NEAR_M = 0.05;

export interface RoiOptions {
  /** Grow the rectangle by this share of its own size, for pose error. */
  padding?: number;
}

/**
 * The region a part should occupy, or `undefined` when it is not in front of
 * the camera at all.
 *
 * Corners behind the camera are dropped rather than projected — a negative
 * depth mirrors the point through the lens and would put the rectangle
 * somewhere confidently wrong — and their absence is reported as `clipped`,
 * because a region that is only partly seen must not be allowed to say a part
 * is missing. So is a rectangle that runs off the edge of the frame.
 */
export function roiForObb(
  obb: Obb,
  viewMatrix: ArrayLike<number>,
  k: CameraIntrinsics,
  opts: RoiOptions = {},
): PartRoi | undefined {
  return roiForCorners(obbCorners(obb), viewMatrix, k, opts);
}

/**
 * The same, for a caller that has plain numbers rather than a three.js `Obb`.
 *
 * The renderer side has its own vector types; this keeps it from importing a
 * second set to describe a box it already knows the dimensions of.
 */
export function roiForBox(
  box: {
    center: readonly [number, number, number];
    halfExtents: readonly [number, number, number];
    rotation: readonly [number, number, number, number];
  },
  viewMatrix: ArrayLike<number>,
  k: CameraIntrinsics,
  opts: RoiOptions = {},
): PartRoi | undefined {
  return roiForObb({
    center: new Vector3(...box.center),
    halfExtents: new Vector3(...box.halfExtents),
    rotation: new Quaternion(...box.rotation),
  }, viewMatrix, k, opts);
}

function roiForCorners(
  worldCorners: Vector3[],
  viewMatrix: ArrayLike<number>,
  k: CameraIntrinsics,
  opts: RoiOptions,
): PartRoi | undefined {
  const corners = worldCorners.map((c) => toViewSpace(c, viewMatrix));
  const inFront = corners.filter((c) => c.z > NEAR_M);
  if (inFront.length === 0) return undefined;

  let minU = Infinity; let minV = Infinity; let maxU = -Infinity; let maxV = -Infinity;
  let nearest = Infinity;
  for (const c of inFront) {
    const { u, v } = projectToImage(c, k);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    nearest = Math.min(nearest, c.length());
  }

  const padding = Math.max(0, opts.padding ?? 0);
  if (padding > 0) {
    const padU = ((maxU - minU) * padding) / 2;
    const padV = ((maxV - minV) * padding) / 2;
    minU -= padU; maxU += padU; minV -= padV; maxV += padV;
  }

  const offFrame = minU < 0 || minV < 0 || maxU > k.width || maxV > k.height;
  const x = Math.max(0, Math.min(k.width, minU));
  const y = Math.max(0, Math.min(k.height, minV));
  const w = Math.max(0, Math.min(k.width, maxU) - x);
  const h = Math.max(0, Math.min(k.height, maxV) - y);
  if (w <= 0 || h <= 0) return undefined;

  return {
    rect: { x, y, w, h },
    areaFraction: (w * h) / Math.max(1, k.width * k.height),
    distanceM: nearest,
    clipped: offFrame || inFront.length < corners.length,
  };
}
