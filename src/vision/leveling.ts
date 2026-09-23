import type { GrayImage } from './imageOps';
import type { Quat } from '../engine/types';

/**
 * The same view, as a camera held level would have seen it.
 *
 * The lattice detector sums edge energy along image rows and columns, so it
 * only finds boards that run along them — a facade seen square-on, within
 * about 20 degrees. Operators do not hold a phone like that: they stand and
 * look *down* at a low shelf, and tip the phone as they go. A device log had
 * the camera 1.2-1.5 m up and pitched steeply at a 72 cm shelf.
 *
 * A camera that only rotates changes the image by a homography, and gravity
 * says which rotation undoes the tilt: turn the camera until world up is its
 * own up and its forward axis is horizontal. After that, vertical edges in the
 * world are vertical in the image and a facade facing the operator is
 * square-on again, whatever the pitch or roll was.
 *
 * Camera space here is the renderer's: +x right, +y up, +z forward, pixels
 * `u = cx + fx·x/z`, `v = cy − fy·y/z` — the convention `perception/roi.ts`
 * pins against Babylon's own projection.
 */

export interface Pinhole {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface Leveling {
  /** Camera pixels → level-camera pixels. */
  H: number[][];
  /** Level-camera pixels → camera pixels. */
  Hinv: number[][];
  /** How far the camera is from level, degrees: pitch and roll together. */
  tiltDeg: number;
}

type V3 = [number, number, number];

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };

/** Rotate `v` by the inverse of unit quaternion `q` — world into camera space. */
function unrotate(v: V3, q: Quat): V3 {
  const u: V3 = [-q[0], -q[1], -q[2]];
  const w = q[3];
  const t = cross(u, v).map((c) => 2 * c) as V3;
  const c = cross(u, t);
  return [v[0] + w * t[0] + c[0], v[1] + w * t[1] + c[1], v[2] + w * t[2] + c[2]];
}

const mul = (A: number[][], B: number[][]): number[][] =>
  A.map((row) => B[0].map((_, j) => row.reduce((s, a, k) => s + a * B[k][j], 0)));

/** Apply a homography to a pixel; undefined when it lands behind the camera. */
export function applyHomography(H: number[][], p: { x: number; y: number }): { x: number; y: number } | undefined {
  const w = H[2][0] * p.x + H[2][1] * p.y + H[2][2];
  if (!(w > 1e-9)) return undefined;
  return {
    x: (H[0][0] * p.x + H[0][1] * p.y + H[0][2]) / w,
    y: (H[1][0] * p.x + H[1][1] * p.y + H[1][2]) / w,
  };
}

/**
 * The leveling homography for a camera with world rotation `cameraRotation`
 * (camera → world, as `SceneManager.cameraToWorld` applies it).
 *
 * Undefined when the camera looks almost straight up or down: there is no
 * horizontal forward direction to level towards, and no facade to see either.
 */
export function levelingHomography(cameraRotation: Quat, k: Pinhole): Leveling | undefined {
  const up = norm(unrotate([0, 1, 0], cameraRotation));
  const z: V3 = [0, 0, 1];
  const along = dot(z, up);
  if (Math.abs(along) > 0.95) return undefined;
  const forward = norm([z[0] - along * up[0], z[1] - along * up[1], z[2] - along * up[2]]);
  const right = cross(up, forward);
  // Rows are the level camera's axes in this camera's frame: M maps a ray
  // here to the same ray in level-camera coordinates.
  const M = [right, up, forward];
  const Mt = [[right[0], up[0], forward[0]], [right[1], up[1], forward[1]], [right[2], up[2], forward[2]]];
  const K = [[k.fx, 0, k.cx], [0, -k.fy, k.cy], [0, 0, 1]];
  const Kinv = [[1 / k.fx, 0, -k.cx / k.fx], [0, -1 / k.fy, k.cy / k.fy], [0, 0, 1]];
  const tiltDeg = (Math.acos(Math.max(-1, Math.min(1, dot(up, [0, 1, 0])))) * 180) / Math.PI;
  return { H: mul(mul(K, M), Kinv), Hinv: mul(mul(K, Mt), Kinv), tiltDeg };
}

/**
 * Turn a leveled view to face the facade square-on.
 *
 * Gravity fixes pitch and roll but cannot know where the shelf is, so a facade
 * seen a little from the side is still a trapezoid after leveling: its bays
 * shrink with distance, the spacing of the vertical boards is no longer even,
 * and an even lattice fitted to them lands the pose 2-7% out at 7-12 degrees.
 * The boards that run across the facade say where it faces: level, they are
 * parallel world lines, so they meet at one vanishing point on the level
 * camera's horizon row. That point is the direction the facade runs in, and a
 * turn about the vertical axis to face square-on is `K·R·K⁻¹` again.
 *
 * `rows` are the across-lines, each as two points in the leveled frame.
 * Returns the combined leveling (camera → square-on), or undefined when the
 * lines are too close to parallel to place a vanishing point — which is what
 * a square-on facade looks like.
 */
export function faceSquareOn(
  level: Leveling,
  rows: [{ x: number; y: number }, { x: number; y: number }][],
  k: Pinhole,
  minYawDeg = 2,
): (Leveling & { yawDeg: number }) | undefined {
  // Each line's crossing of the horizon row, weighted by how far from the
  // horizon it is — a line near the horizon barely constrains the point.
  let sum = 0;
  let weight = 0;
  for (const [a, b] of rows) {
    const dy = b.y - a.y;
    const dx = b.x - a.x;
    if (Math.abs(dy) < 1e-6 || Math.abs(dx) < 1e-6) continue;
    const w = Math.abs((a.y + b.y) / 2 - k.cy);
    // Where the line meets y = cy, expressed as the direction it points in:
    // x-offset of the vanishing point per unit focal length, inverted so a
    // near-parallel line (vanishing point at infinity) contributes ~0.
    const u = a.x + ((k.cy - a.y) * dx) / dy;
    const inv = k.fx / (u - k.cx);
    sum += w * inv;
    weight += w;
  }
  if (weight <= 0) return undefined;
  const inv = sum / weight;
  // The across direction in level-camera space is (1, 0, inv) up to scale:
  // (u − cx)/fx = x/z = 1/inv.
  const across = norm([1, 0, inv]);
  const yawDeg = (Math.atan2(across[2], across[0]) * 180) / Math.PI;
  if (Math.abs(yawDeg) < minYawDeg || Math.abs(yawDeg) > 45) return undefined;
  return turnAboutVertical(level, yawDeg, k);
}

/**
 * A leveled view turned by `yawDeg` about the vertical axis — to face a facade
 * that runs off at that angle. Positive turns towards a facade whose far end is
 * to the right.
 */
export function turnAboutVertical(level: Leveling, yawDeg: number, k: Pinhole): Leveling & { yawDeg: number } {
  const t = (yawDeg * Math.PI) / 180;
  const across: V3 = [Math.cos(t), 0, Math.sin(t)];
  const up: V3 = [0, 1, 0];
  const forward = cross(across, up);
  const M = [across, up, forward];
  const Mt = [[across[0], up[0], forward[0]], [across[1], up[1], forward[1]], [across[2], up[2], forward[2]]];
  const K = [[k.fx, 0, k.cx], [0, -k.fy, k.cy], [0, 0, 1]];
  const Kinv = [[1 / k.fx, 0, -k.cx / k.fx], [0, -1 / k.fy, k.cy / k.fy], [0, 0, 1]];
  const Hyaw = mul(mul(K, M), Kinv);
  const HyawInv = mul(mul(K, Mt), Kinv);
  return { H: mul(Hyaw, level.H), Hinv: mul(level.Hinv, HyawInv), tiltDeg: level.tiltDeg, yawDeg };
}

/** The leveling that changes nothing — for a camera already held level. */
export const IDENTITY_LEVELING: Leveling = {
  H: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  Hinv: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  tiltDeg: 0,
};

/**
 * Resample a working-resolution gray image into the level camera's view.
 *
 * The output covers where the source lands, clamped to one and a half frames
 * around the principal point — a steep pitch sends the part of the image near
 * the horizon towards infinity, and nothing worth detecting is out there. Its
 * pixel size is kept close to the source's, then grown if the area would
 * exceed `maxAreaFactor` times the source, so the cost stays bounded.
 *
 * Returns the image and where its pixel (0, 0) sits in level-camera pixels.
 * Pixel index n maps to coordinate `origin + n·scale`, the same convention
 * `toGray` and the detector use, so the plain and leveled paths agree.
 */
export function warpToLevel(
  gray: GrayImage,
  sourceSize: { width: number; height: number },
  level: Leveling,
  k: Pinhole,
  maxAreaFactor = 2.5,
): { gray: GrayImage; origin: { x: number; y: number } } | undefined {
  const { width: W, height: H } = sourceSize;
  const corners = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]
    .map((p) => applyHomography(level.H, p))
    .filter((p): p is { x: number; y: number } => p !== undefined);
  if (corners.length === 0) return undefined;
  const clampX = (x: number) => Math.max(k.cx - 1.5 * W, Math.min(k.cx + 1.5 * W, x));
  const clampY = (y: number) => Math.max(k.cy - 1.5 * H, Math.min(k.cy + 1.5 * H, y));
  const x0 = clampX(Math.min(...corners.map((p) => p.x)));
  const x1 = clampX(Math.max(...corners.map((p) => p.x)));
  const y0 = clampY(Math.min(...corners.map((p) => p.y)));
  const y1 = clampY(Math.max(...corners.map((p) => p.y)));
  if (x1 - x0 < 16 || y1 - y0 < 16) return undefined;

  let scale = gray.scale;
  const area = ((x1 - x0) / scale) * ((y1 - y0) / scale);
  const limit = gray.width * gray.height * maxAreaFactor;
  if (area > limit) scale *= Math.sqrt(area / limit);
  const width = Math.max(1, Math.floor((x1 - x0) / scale));
  const height = Math.max(1, Math.floor((y1 - y0) / scale));

  // Pixels that map outside the source take its mean, so the frame's edge
  // does not become the strongest "board" in the picture.
  let mean = 0;
  for (let i = 0; i < gray.data.length; i++) mean += gray.data[i];
  mean /= Math.max(1, gray.data.length);

  const data = new Float32Array(width * height);
  const Hi = level.Hinv;
  for (let j = 0; j < height; j++) {
    const vy = y0 + j * scale;
    for (let i = 0; i < width; i++) {
      const vx = x0 + i * scale;
      const w = Hi[2][0] * vx + Hi[2][1] * vy + Hi[2][2];
      let value = mean;
      if (w > 1e-9) {
        const sx = (Hi[0][0] * vx + Hi[0][1] * vy + Hi[0][2]) / w / gray.scale;
        const sy = (Hi[1][0] * vx + Hi[1][1] * vy + Hi[1][2]) / w / gray.scale;
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        if (ix >= 0 && iy >= 0 && ix < gray.width - 1 && iy < gray.height - 1) {
          const fx = sx - ix;
          const fy = sy - iy;
          const a = gray.data[iy * gray.width + ix];
          const b = gray.data[iy * gray.width + ix + 1];
          const c = gray.data[(iy + 1) * gray.width + ix];
          const d = gray.data[(iy + 1) * gray.width + ix + 1];
          value = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        }
      }
      data[j * width + i] = value;
    }
  }
  return { gray: { data, width, height, scale }, origin: { x: x0, y: y0 } };
}
