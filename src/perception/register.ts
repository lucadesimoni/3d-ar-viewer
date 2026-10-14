import { Quaternion, Vector3 } from 'three';
import type { AssemblyDef, MeshSpec, Pose } from '../engine/types';
import { meshHalfExtents } from '../engine/collision';
import { toGray } from '../vision/imageOps';
import type { CameraIntrinsics } from './intrinsics';
import { NEAR_M } from './roi';

/**
 * Model-based registration: move an assembly's pose until its edges sit on the
 * camera image's edges. Generic: it uses only the parts' geometry, so it
 * works for any assembly, of any shape.
 *
 * It refines a pose rather than finding one from nothing. The start is
 * whatever the app has: a tap on the floor, a WebXR anchor, the shelf
 * detector. From there:
 *
 *  - Every visible edge of every part's box is sampled in 3D. Each sample is
 *    projected, and the image is searched along the projected edge's normal
 *    for the strongest gradient *across* that edge. A board's edge runs
 *    parallel to the model's; the texture of a wicker basket mostly does not.
 *  - The pose is solved by iteratively reweighted least squares (Tukey
 *    weights), so a minority of wrong matches (clutter, a hand, a part not
 *    fitted yet) cannot pull it. It runs coarse to fine: a wide search window
 *    first, then narrower ones.
 *  - By default only what a thing standing on the floor can move: across
 *    the floor and turning about the vertical. Height and tilt are what the
 *    platform's floor and gravity already measure well.
 *  - It reports how much of the model agrees with the image before and after,
 *    and accepts the new pose only if the fit is convincing and better than the
 *    start. Otherwise the caller keeps the pose it had.
 */

/** A point on a model edge, in the assembly's own frame. */
export interface EdgeSample {
  p: Vector3;
  /** The edge's direction. */
  dir: Vector3;
  /** Normals of the two faces that meet at the edge. */
  n1: Vector3;
  n2: Vector3;
  /**
   * A crease (a box's corner, a cylinder's rim) shows whenever a face beside
   * it is seen. A smooth edge (along a cylinder's side, across a sphere) shows
   * only as the outline: where one face turns towards the camera and the other away.
   */
  crease: boolean;
  /** Which part it belongs to: index into the model's boxes. */
  part: number;
}

/** An edge of a part's shape, in the part's own frame. */
export interface ModelEdge {
  a: Vector3;
  b: Vector3;
  n1: Vector3;
  n2: Vector3;
  crease: boolean;
}

/** A part's box in the assembly frame, for hiding what is behind it. */
interface PartBox { center: Vector3; axes: [Vector3, Vector3, Vector3]; half: Vector3 }

/** What registration matches against the image. */
export interface EdgeModel {
  samples: EdgeSample[];
  boxes: PartBox[];
}

/** The camera image as gradients, for searching across model edges. */
export interface GradientField {
  width: number;
  height: number;
  /** Full-resolution pixels per working pixel. */
  scale: number;
  gx: Float32Array;
  gy: Float32Array;
  /** What a directional gradient must beat to count: the frame's own mean magnitude plus one deviation. */
  floor: number;
}

export function gradientField(image: ImageData, workingSize = 640): GradientField {
  const gray = toGray(image, workingSize);
  const { data: g, width: w, height: h, scale } = gray;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  let sum = 0; let sum2 = 0; let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // Sobel: smoother than a central difference, so texture says less.
      const a = g[i - w - 1]; const b = g[i - w]; const c = g[i - w + 1];
      const d = g[i - 1]; const f = g[i + 1];
      const e = g[i + w - 1]; const m = g[i + w]; const o = g[i + w + 1];
      const vx = (c + 2 * f + o - a - 2 * d - e) / 8;
      const vy = (e + 2 * m + o - a - 2 * b - c) / 8;
      gx[i] = vx; gy[i] = vy;
      const mag = Math.sqrt(vx * vx + vy * vy);
      sum += mag; sum2 += mag * mag; n++;
    }
  }
  const mean = n ? sum / n : 0;
  const std = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;
  return { width: w, height: h, scale, gx, gy, floor: std > 1e-6 ? mean + std : Infinity };
}

/**
 * The image's gradients at several sizes, finest first. The wide searches,
 * early on, read a coarse level, where a board's edge survives and the weave
 * of a basket has blurred away; the narrow ones, at the end, read the fine one.
 */
export type GradientPyramid = GradientField[];

export function gradientPyramid(image: ImageData, finest = 640, levels = 3): GradientPyramid {
  return Array.from({ length: levels }, (_, i) => gradientField(image, Math.round(finest / 2 ** i)));
}

/** The level for a search ±window px wide: the coarsest that still gives it a few of its own pixels. */
function levelFor(fields: GradientPyramid, window: number): GradientField {
  let pick = fields[0];
  for (const f of fields) if (f.scale <= window / 6) pick = f;
  return pick;
}

/** The gradient across direction (nx, ny) at full-resolution (u, v), bilinear. */
function across(f: GradientField, u: number, v: number, nx: number, ny: number): number {
  // A working pixel averages the full-resolution block [x·scale, (x+1)·scale): its centre is half a pixel in.
  const x = u / f.scale - 0.5; const y = v / f.scale - 0.5;
  if (x < 1 || y < 1 || x > f.width - 2 || y > f.height - 2) return 0;
  const x0 = Math.floor(x); const y0 = Math.floor(y);
  const fx = x - x0; const fy = y - y0;
  const at = (i: number) => Math.abs(f.gx[i] * nx + f.gy[i] * ny);
  const i = y0 * f.width + x0;
  const top = at(i) * (1 - fx) + at(i + 1) * fx;
  const bottom = at(i + f.width) * (1 - fx) + at(i + f.width + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * The strongest edge across (nx, ny) within ±window full-resolution pixels
 * of (u, v): its signed offset along the normal, or undefined if nothing
 * there beats the frame's floor.
 */
export function searchAcross(f: GradientField, u: number, v: number, nx: number, ny: number, window: number): number | undefined {
  const step = f.scale / 2;
  const steps = Math.max(1, Math.floor(window / step));
  let best = 0; let bestT = 0;
  for (let s = -steps; s <= steps; s++) {
    const t = s * step;
    const m = across(f, u + nx * t, v + ny * t, nx, ny);
    if (m > best) { best = m; bestT = t; }
  }
  if (!(best > f.floor)) return undefined;
  const prev = across(f, u + nx * (bestT - step), v + ny * (bestT - step), nx, ny);
  const next = across(f, u + nx * (bestT + step), v + ny * (bestT + step), nx, ny);
  const denom = prev - 2 * best + next;
  const shift = denom !== 0 ? (0.5 * (prev - next)) / denom : 0;
  return bestT + Math.max(-1, Math.min(1, shift)) * step;
}

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
/** Segments around a circle: the outline of a 24-gon is within 1% of the radius of the circle's. */
const ROUND = 24;
const radial = (theta: number) => new Vector3(Math.cos(theta), 0, Math.sin(theta));

/** The 12 edges of a box, all creases. */
function boxEdges(he: Vector3): ModelEdge[] {
  const out: ModelEdge[] = [];
  const axes = [X, Y, Z];
  const h = [he.x, he.y, he.z];
  // Each edge runs along one axis, at one of four corners of the other two.
  for (let along = 0; along < 3; along++) {
    const [i, j] = [0, 1, 2].filter((k) => k !== along);
    for (const si of [-1, 1]) {
      for (const sj of [-1, 1]) {
        const base = new Vector3().addScaledVector(axes[i], si * h[i]).addScaledVector(axes[j], sj * h[j]);
        out.push({
          a: base.clone().addScaledVector(axes[along], -h[along]),
          b: base.clone().addScaledVector(axes[along], h[along]),
          n1: axes[i].clone().multiplyScalar(si),
          n2: axes[j].clone().multiplyScalar(sj),
          crease: true,
        });
      }
    }
  }
  return out;
}

/**
 * A circle of radius r at height y about the y axis, as the crease between a
 * flat face (normal `cap`) and a round wall (normal outward, or inward for a bore).
 */
function rimEdges(r: number, y: number, cap: Vector3, inward: boolean): ModelEdge[] {
  const out: ModelEdge[] = [];
  for (let i = 0; i < ROUND; i++) {
    const t0 = (2 * Math.PI * i) / ROUND; const t1 = (2 * Math.PI * (i + 1)) / ROUND;
    const wall = radial((t0 + t1) / 2).multiplyScalar(inward ? -1 : 1);
    out.push({
      a: radial(t0).multiplyScalar(r).setY(y), b: radial(t1).multiplyScalar(r).setY(y),
      n1: cap.clone(), n2: wall, crease: true,
    });
  }
  return out;
}

/** A round wall's lines from bottom to top: smooth, so seen only where they are its outline. */
function sideEdges(r: number, h: number): ModelEdge[] {
  const out: ModelEdge[] = [];
  for (let i = 0; i < ROUND; i++) {
    const t = (2 * Math.PI * i) / ROUND; const half = Math.PI / ROUND;
    const p = radial(t).multiplyScalar(r);
    out.push({
      a: p.clone().setY(-h / 2), b: p.clone().setY(h / 2),
      n1: radial(t - half), n2: radial(t + half), crease: false,
    });
  }
  return out;
}

function sphereEdges(r: number): ModelEdge[] {
  const out: ModelEdge[] = [];
  const LAT = ROUND / 2;
  const at = (lat: number, lon: number) => new Vector3(
    Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon),
  );
  const latOf = (j: number) => -Math.PI / 2 + (Math.PI * j) / LAT;
  const lonOf = (i: number) => (2 * Math.PI * i) / ROUND;
  for (let j = 0; j < LAT; j++) {
    for (let i = 0; i < ROUND; i++) {
      const midLat = (latOf(j) + latOf(j + 1)) / 2;
      // Along a meridian, between the faces either side of it.
      out.push({
        a: at(latOf(j), lonOf(i)).multiplyScalar(r), b: at(latOf(j + 1), lonOf(i)).multiplyScalar(r),
        n1: at(midLat, lonOf(i) - Math.PI / ROUND), n2: at(midLat, lonOf(i) + Math.PI / ROUND), crease: false,
      });
      // Along a parallel, between the faces above and below it.
      if (j > 0) {
        const midLon = (lonOf(i) + lonOf(i + 1)) / 2;
        out.push({
          a: at(latOf(j), lonOf(i)).multiplyScalar(r), b: at(latOf(j), lonOf(i + 1)).multiplyScalar(r),
          n1: at((latOf(j - 1) + latOf(j)) / 2, midLon), n2: at(midLat, midLon), crease: false,
        });
      }
    }
  }
  return out;
}

/**
 * The edges of a part's shape, in its own frame, for the shapes the app
 * builds itself. A part loaded from a file has none here: its triangles are
 * known only once loaded, and `edgesFromTriangles` turns them into edges.
 */
export function shapeEdges(mesh: MeshSpec): ModelEdge[] {
  switch (mesh.type) {
    case 'box':
      return boxEdges(meshHalfExtents(mesh));
    case 'plate': {
      const he = meshHalfExtents(mesh);
      const out = boxEdges(he);
      if (mesh.holeRadius) {
        out.push(...rimEdges(mesh.holeRadius, he.y, Y, true), ...rimEdges(mesh.holeRadius, -he.y, Y.clone().negate(), true));
      }
      return out;
    }
    case 'cylinder':
      return [
        ...rimEdges(mesh.radius, mesh.height / 2, Y, false),
        ...rimEdges(mesh.radius, -mesh.height / 2, Y.clone().negate(), false),
        ...sideEdges(mesh.radius, mesh.height),
      ];
    case 'tube': {
      const inner = Math.max(0, mesh.radius - mesh.wall);
      return [
        ...rimEdges(mesh.radius, mesh.height / 2, Y, false),
        ...rimEdges(mesh.radius, -mesh.height / 2, Y.clone().negate(), false),
        ...sideEdges(mesh.radius, mesh.height),
        ...(inner > 0 ? [
          ...rimEdges(inner, mesh.height / 2, Y, true),
          ...rimEdges(inner, -mesh.height / 2, Y.clone().negate(), true),
        ] : []),
      ];
    }
    case 'sphere':
      return sphereEdges(mesh.radius);
    case 'url':
      return [];
  }
}

/**
 * The edges of any triangle mesh: where two triangles meet at more than
 * `creaseDeg`, a crease; elsewhere, a smooth edge that shows only as the
 * outline. Vertices are welded by position first, since a mesh splits them
 * wherever its normals or texture coordinates jump. Edges shorter than
 * `minLengthM` are dropped, and if more than `maxEdges` remain, the longest
 * are kept: a scanned model's thousand tiny facets say less than its outline.
 *
 * Which way a face points comes from its winding, unless `normals` (one per
 * vertex, as a file carries them) are given: then each face is turned to agree
 * with its vertices' normals. A mirrored import (a glTF converted between
 * handedness) winds every triangle backwards, and the file's normals are
 * what still says which side is outside.
 */
export function edgesFromTriangles(
  positions: ArrayLike<number>, indices: ArrayLike<number>,
  opts: { creaseDeg?: number; minLengthM?: number; maxEdges?: number; normals?: ArrayLike<number> } = {},
): ModelEdge[] {
  const creaseCos = Math.cos(((opts.creaseDeg ?? 30) * Math.PI) / 180);
  const minLength = opts.minLengthM ?? 0.004;
  const maxEdges = opts.maxEdges ?? 1500;
  const weld = new Map<string, number>();
  const verts: Vector3[] = [];
  const idOf = (i: number) => {
    const v = new Vector3(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    const key = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    let id = weld.get(key);
    if (id === undefined) { id = verts.length; verts.push(v); weld.set(key, id); }
    return id;
  };
  const faces = new Map<string, Vector3[]>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ids = [idOf(indices[t]), idOf(indices[t + 1]), idOf(indices[t + 2])];
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
    const [p, q, r] = ids.map((i) => verts[i]);
    const n = q.clone().sub(p).cross(r.clone().sub(p));
    if (n.lengthSq() < 1e-16) continue;
    n.normalize();
    const vn = opts.normals;
    if (vn) {
      let dot = 0;
      for (let k = 0; k < 3; k++) {
        const i = indices[t + k];
        dot += n.x * vn[3 * i] + n.y * vn[3 * i + 1] + n.z * vn[3 * i + 2];
      }
      if (dot < 0) n.negate();
    }
    for (let e = 0; e < 3; e++) {
      const a = ids[e]; const b = ids[(e + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const list = faces.get(key);
      if (list) list.push(n); else faces.set(key, [n]);
    }
  }
  const out: (ModelEdge & { length: number })[] = [];
  for (const [key, normals] of faces) {
    const [a, b] = key.split('|').map(Number);
    const length = verts[a].distanceTo(verts[b]);
    if (length < minLength) continue;
    // An open border is a crease against nothing: seen whenever its face is.
    const [n1, n2] = normals.length >= 2 ? [normals[0], normals[1]] : [normals[0], normals[0]];
    const crease = normals.length !== 2 || n1.dot(n2) < creaseCos;
    out.push({ a: verts[a].clone(), b: verts[b].clone(), n1, n2, crease, length });
  }
  out.sort((p, q) => q.length - p.length);
  return out.slice(0, maxEdges).map(({ length: _length, ...e }) => e);
}

/**
 * Points along the edges of every part, in the assembly frame, about
 * `spacingM` apart (at least 2 and at most 10 per edge, so a long board does
 * not drown out a small part). `edges` supplies a part's edges where the
 * caller has them, for parts loaded from a file; a part with no edges at all
 * is left out rather than guessed at, since a guessed outline would be
 * matched against edges that are not there.
 */
export function edgeModel(
  assembly: AssemblyDef,
  opts: { spacingM?: number; partIds?: Set<string>; edges?: Map<string, ModelEdge[]>; maxSamples?: number } = {},
): EdgeModel {
  const spacing = opts.spacingM ?? 0.04;
  const maxSamples = opts.maxSamples ?? MAX_SAMPLES;
  const samples: EdgeSample[] = [];
  const boxes: PartBox[] = [];
  for (const part of assembly.parts) {
    if (opts.partIds && !opts.partIds.has(part.id)) continue;
    const edges = opts.edges?.get(part.id) ?? shapeEdges(part.mesh);
    if (edges.length === 0) continue;
    const q = new Quaternion(...part.targetPose.rotation);
    const t = new Vector3(...part.targetPose.position);
    const index = boxes.length;
    boxes.push({
      center: t.clone(),
      axes: [X.clone().applyQuaternion(q), Y.clone().applyQuaternion(q), Z.clone().applyQuaternion(q)],
      half: meshHalfExtents(part.mesh),
    });
    for (const e of edges) {
      const pa = e.a.clone().applyQuaternion(q).add(t);
      const pb = e.b.clone().applyQuaternion(q).add(t);
      const length = pa.distanceTo(pb);
      if (length < 1e-4) continue;
      const n = Math.max(e.crease ? 2 : 1, Math.min(10, Math.round(length / spacing)));
      const dir = pb.clone().sub(pa).normalize();
      const n1 = e.n1.clone().applyQuaternion(q);
      const n2 = e.n2.clone().applyQuaternion(q);
      for (let i = 0; i < n; i++) {
        samples.push({ p: pa.clone().lerp(pb, (i + 0.5) / n), dir, n1, n2, crease: e.crease, part: index });
      }
    }
  }
  // A rack of a hundred parts gives ten thousand samples: evenly thinned, so
  // the cost stays that of a small assembly and every part keeps its share.
  if (samples.length <= maxSamples) return { samples, boxes };
  const stride = samples.length / maxSamples;
  return { samples: Array.from({ length: maxSamples }, (_, i) => samples[Math.floor(i * stride)]), boxes };
}

/** Samples kept at most: what one look can afford, on a phone, a few times a second at worst. */
const MAX_SAMPLES = 1200;

/** The camera's world position, from a view matrix laid out as `toViewSpace` reads it. */
export function cameraPositionOf(view: ArrayLike<number>): [number, number, number] {
  // view = [R | t] with R's rows the camera's axes: the camera is at -Rᵀt.
  const t = [view[12], view[13], view[14]];
  return [0, 1, 2].map((j) => -(view[j * 4] * t[0] + view[j * 4 + 1] * t[1] + view[j * 4 + 2] * t[2])) as [number, number, number];
}

/** What may move: across the floor and about the vertical, or all six degrees of freedom. */
export type RegistrationFreedom = 'floor' | 'full';

export interface RegistrationInput {
  field: GradientField | GradientPyramid;
  model: EdgeModel;
  /** The assembly's pose in the world: the starting guess. */
  start: Pose;
  /** The renderer's view matrix (`SceneManager.viewMatrix()`), and the camera's world position. */
  viewMatrix: ArrayLike<number>;
  cameraPosition: [number, number, number];
  k: CameraIntrinsics;
  freedom?: RegistrationFreedom;
  /** Search windows, full-resolution pixels, widest first. */
  windows?: number[];
}

export interface RegistrationResult {
  pose: Pose;
  /** Share of visible samples with an edge across them within a few pixels: at the start, and at the end. */
  before: number;
  after: number;
  /** Visible samples at the end. */
  visible: number;
  /** The fit is convincing and better than the start: use `pose`. */
  accepted: boolean;
  /** Why not, when it was not. */
  reason?: 'too-few-visible' | 'no-improvement' | 'weak-fit' | 'lopsided' | 'moved-too-far' | 'ambiguous';
  /** Agreement in the worst quarter of the outline, at the end. */
  weakest: number;
  /** The best agreement of any other pose nearby: close to `after`, and the image does not say which is right. */
  rival: number;
}

/** The parameters, applied to the start pose: translation in the world, then rotation about the start's origin. */
function poseAt(start: Pose, x: number[]): Pose {
  const [tx, ty, tz, yaw, pitch, roll] = x;
  const rot = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll));
  const q = rot.multiply(new Quaternion(...start.rotation));
  return {
    position: [start.position[0] + tx, start.position[1] + ty, start.position[2] + tz],
    rotation: [q.x, q.y, q.z, q.w],
  };
}

interface Projected { u: number; v: number; nx: number; ny: number }

/** A pose as a rotation (row-major 3×3) and a translation, for arithmetic without allocation. */
function rigid(pose: Pose): { r: number[]; t: number[] } {
  const [x, y, z, w] = pose.rotation;
  return {
    r: [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ],
    t: [...pose.position],
  };
}

/** Where a ray from `o` along unit `d` enters a box (centre `c`, unit axes `ax` as 9 numbers), or Infinity if it misses. */
function entry(o: number[], d: number[], half: Vector3, c: number[], ax: number[]): number {
  let near = -Infinity; let far = Infinity;
  const rx = o[0] - c[0]; const ry = o[1] - c[1]; const rz = o[2] - c[2];
  const hs = [half.x, half.y, half.z];
  for (let k = 0; k < 3; k++) {
    // Shrunk a little, so a part touching another does not hide its own edge.
    const h = Math.max(0, hs[k] - OCCLUDER_SHRINK_M);
    const a0 = ax[3 * k]; const a1 = ax[3 * k + 1]; const a2 = ax[3 * k + 2];
    const e = a0 * rx + a1 * ry + a2 * rz; const f = a0 * d[0] + a1 * d[1] + a2 * d[2];
    if (Math.abs(f) < 1e-9) { if (Math.abs(e) > h) return Infinity; continue; }
    let t1 = (-h - e) / f; let t2 = (h - e) / f;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > near) near = t1;
    if (t2 < far) far = t2;
    if (near > far) return Infinity;
  }
  return far < 0 ? Infinity : Math.max(0, near);
}
const OCCLUDER_SHRINK_M = 0.003;

/**
 * Which samples the camera sees at this pose: the edge shows (a crease beside
 * a face turned to the camera, a smooth edge on the outline), and no other
 * part's box stands between it and the camera.
 */
function visibility(model: EdgeModel, pose: Pose, input: RegistrationInput): boolean[] {
  const { r, t } = rigid(pose);
  const rot = (v: Vector3, out: number[]) => {
    out[0] = r[0] * v.x + r[1] * v.y + r[2] * v.z;
    out[1] = r[3] * v.x + r[4] * v.y + r[5] * v.z;
    out[2] = r[6] * v.x + r[7] * v.y + r[8] * v.z;
    return out;
  };
  const cam = input.cameraPosition;
  const boxes = model.boxes.map((b) => {
    const c = rot(b.center, [0, 0, 0]);
    return {
      c: [c[0] + t[0], c[1] + t[1], c[2] + t[2]],
      ax: [...rot(b.axes[0], [0, 0, 0]), ...rot(b.axes[1], [0, 0, 0]), ...rot(b.axes[2], [0, 0, 0])],
    };
  });
  const w = [0, 0, 0]; const n = [0, 0, 0]; const dir = [0, 0, 0];
  return model.samples.map((s) => {
    rot(s.p, w);
    const tx = cam[0] - w[0] - t[0]; const ty = cam[1] - w[1] - t[1]; const tz = cam[2] - w[2] - t[2];
    rot(s.n1, n); const d1 = n[0] * tx + n[1] * ty + n[2] * tz;
    rot(s.n2, n); const d2 = n[0] * tx + n[1] * ty + n[2] * tz;
    if (s.crease ? d1 <= 0 && d2 <= 0 : d1 * d2 > 0) return false;
    const dist = Math.hypot(tx, ty, tz);
    dir[0] = -tx / dist; dir[1] = -ty / dist; dir[2] = -tz / dist; // camera → sample
    for (let b = 0; b < boxes.length; b++) {
      if (b === s.part) continue;
      if (entry(cam, dir, model.boxes[b].half, boxes[b].c, boxes[b].ax) < dist - OCCLUDER_SHRINK_M) return false;
    }
    return true;
  });
}

/** Where each visible sample lands in the image, and its edge's normal there; undefined where hidden. */
function project(model: EdgeModel, pose: Pose, input: RegistrationInput, visible: boolean[]): (Projected | undefined)[] {
  const { r, t } = rigid(pose);
  const m = input.viewMatrix;
  // The view applied after the pose, folded into one 3×4 map: rows are view x, y, z.
  // The same arithmetic as `toViewSpace` and `projectToImage` in roi.ts, whose
  // tests pin it to Babylon's own projection; unrolled, since it runs a hundred
  // thousand times a look.
  const A: number[] = []; const b: number[] = [];
  for (let i = 0; i < 3; i++) {
    const v0 = m[i]; const v1 = m[4 + i]; const v2 = m[8 + i];
    A.push(v0 * r[0] + v1 * r[3] + v2 * r[6], v0 * r[1] + v1 * r[4] + v2 * r[7], v0 * r[2] + v1 * r[5] + v2 * r[8]);
    b.push(v0 * t[0] + v1 * t[1] + v2 * t[2] + m[12 + i]);
  }
  const { fx, fy, cx, cy, width, height } = input.k;
  return model.samples.map((s, i) => {
    if (!visible[i]) return undefined;
    const p = s.p;
    const ax = A[0] * p.x + A[1] * p.y + A[2] * p.z + b[0];
    const ay = A[3] * p.x + A[4] * p.y + A[5] * p.z + b[1];
    const az = A[6] * p.x + A[7] * p.y + A[8] * p.z + b[2];
    if (az <= NEAR_M) return undefined;
    const d = s.dir;
    const bx = ax + 0.01 * (A[0] * d.x + A[1] * d.y + A[2] * d.z);
    const by = ay + 0.01 * (A[3] * d.x + A[4] * d.y + A[5] * d.z);
    const bz = az + 0.01 * (A[6] * d.x + A[7] * d.y + A[8] * d.z);
    if (bz <= NEAR_M) return undefined;
    const u = cx + (fx * ax) / az; const v = cy - (fy * ay) / az;
    if (u < 0 || v < 0 || u >= width || v >= height) return undefined;
    const dx = cx + (fx * bx) / bz - u; const dy = cy - (fy * by) / bz - v;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return undefined;
    return { u, v, nx: -dy / len, ny: dx / len };
  });
}

/** Where the model's visible edges fall in the image at `pose`: for drawing it, and for checking a fit by eye. */
export function projectedEdges(pose: Pose, input: Omit<RegistrationInput, 'field' | 'start'>): { u: number; v: number }[] {
  const full = { ...input, field: undefined as unknown as GradientField, start: pose };
  return project(input.model, pose, full, visibility(input.model, pose, full))
    .filter((p): p is Projected => p !== undefined).map(({ u, v }) => ({ u, v }));
}

const finest = (input: RegistrationInput): GradientField => (Array.isArray(input.field) ? input.field[0] : input.field);

/**
 * How far apart two poses put the model's edges in the image: the mean
 * distance, in pixels, across each edge visible at `a`, between where it
 * lands at `a` and at `b`. Across, because sliding along an edge does not
 * change the picture: a round tank turned about its axis is the same tank.
 */
export function displacementPx(a: Pose, b: Pose, input: Omit<RegistrationInput, 'field' | 'start'>): number {
  const full = { ...input, field: [] as GradientPyramid, start: a };
  return acrossPx(project(input.model, a, full, visibility(input.model, a, full)), b, full);
}

function acrossPx(from: (Projected | undefined)[], b: Pose, input: RegistrationInput): number {
  const pb = project(input.model, b, input, from.map((p) => p !== undefined));
  let sum = 0; let n = 0;
  from.forEach((p, i) => { const q = pb[i]; if (p && q) { sum += Math.abs((q.u - p.u) * p.nx + (q.v - p.v) * p.ny); n++; } });
  return n ? sum / n : Infinity;
}

/** Share of the visible samples with an edge across them within `window` px. */
interface Agreement {
  share: number;
  visible: number;
  /**
   * The share in the worst quarter of the model's outline in the image (split
   * at its median column and row). A fit turned the wrong way sits on one
   * side and misses the other; a right one agrees all round.
   */
  weakest: number;
}

function agreement(pose: Pose, input: RegistrationInput, window: number, mask?: boolean[]): Agreement {
  const proj = project(input.model, pose, input, mask ?? visibility(input.model, pose, input))
    .filter((p): p is Projected => p !== undefined);
  if (proj.length === 0) return { share: 0, visible: 0, weakest: 0 };
  const hit = proj.map((p) => {
    const o = searchAcross(finest(input), p.u, p.v, p.nx, p.ny, window);
    return o !== undefined && Math.abs(o) <= window;
  });
  const mid = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const mu = mid(proj.map((p) => p.u)); const mv = mid(proj.map((p) => p.v));
  const quarters = [[0, 0], [0, 0], [0, 0], [0, 0]];
  proj.forEach((p, i) => {
    const q = quarters[(p.u < mu ? 0 : 1) + (p.v < mv ? 0 : 2)];
    q[1]++; if (hit[i]) q[0]++;
  });
  const shares = quarters.filter(([, n]) => n >= 4).map(([h, n]) => h / n);
  const hits = hit.filter(Boolean).length;
  return { share: hits / proj.length, visible: proj.length, weakest: shares.length ? Math.min(...shares) : 0 };
}

/** Solve a small symmetric positive system by Gaussian elimination; undefined if singular. */
function solve(A: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return undefined;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** The final agreement window: within this many pixels counts as on the edge. */
const AGREE_PX = 3;
/** A fit no better than this share of the model agreeing is not trusted. */
export const MIN_AGREEMENT = 0.45;
/** And it must beat the start by at least this much to be worth moving to. */
const MIN_GAIN = 0.03;
/** Fewer visible samples than this, and there is too little of the model in view to say anything. */
const MIN_VISIBLE = 24;
/**
 * Further than this from the start, it has walked to a different object:
 * refuse. At most 30 cm, and for something small, half its own size: a
 * gearbox does not need moving by its own width to sit on itself.
 */
const MAX_MOVE_M = 0.3;
const MAX_MOVE_SIZES = 0.5;
/** A fit must keep this much of what was in view at the start: one that slid off the picture has found something else. */
const MIN_KEPT = 0.6;
/** Every quarter of the outline must agree this well: a fit turned or slid the wrong way sits on one side only. */
const MIN_WEAKEST = 0.3;
const MAX_TURN_RAD = (20 * Math.PI) / 180;
/**
 * Rivals: from the fit, the pose is also tried this far off, along the
 * assembly's own width and depth and about the vertical, and refined. A
 * shelf's cells repeat, as do a rack's rails and an engine's blades, so a
 * fit a whole cell out agrees with most of the image. What tells the true
 * fit is that nothing else nearby fits as well.
 */
const RIVAL_SHIFTS_M = [0.08, 0.16, 0.28, 0.4];
const RIVAL_TURNS_RAD = [(6 * Math.PI) / 180, (12 * Math.PI) / 180];
/**
 * A rival whose edges land this many pixels from the fit's, on average, is
 * a different pose. Nearer, it is the same fit: along the line of sight a
 * few centimetres barely change the picture, and that is no ambiguity about
 * what is where.
 */
const DISTINCT_PX = 6;
/** ...and if it agrees within this much of the fit, the image does not say which is right. */
const RIVAL_MARGIN = 0.06;

/** The pull to the start, in squared pixels per unit of each parameter (metres, radians). */
const PRIOR = 50;

/** The model's size: the largest extent of the box round all its parts, metres. */
function modelSize(model: EdgeModel): number {
  const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity];
  for (const s of model.samples) {
    const p = [s.p.x, s.p.y, s.p.z];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  }
  return Math.max(0, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/** IRLS from `x`, coarse to fine: the parameters at the end. */
function refine(input: RegistrationInput, from: number[], free: number[], windows: number[], mask?: boolean[]): number[] {
  const x = [...from];
  const eps = 1e-3;
  for (const window of windows) {
    const field = Array.isArray(input.field) ? levelFor(input.field, window) : input.field;
    // What is seen hardly changes within one window's steps: worked out once per window.
    const visible = mask ?? visibility(input.model, poseAt(input.start, x), input);
    for (let iter = 0; iter < 4; iter++) {
      const pose = poseAt(input.start, x);
      const proj = project(input.model, pose, input, visible);
      // Correspondences at this pose: the edge found across each projected sample.
      const pairs: { i: number; r: number }[] = [];
      proj.forEach((p, i) => {
        if (!p) return;
        const o = searchAcross(field, p.u, p.v, p.nx, p.ny, window);
        if (o !== undefined) pairs.push({ i, r: o });
      });
      if (pairs.length < MIN_VISIBLE / 2) return x;
      // Jacobian of each sample's position along its normal, by finite differences.
      const J: number[][] = pairs.map(() => []);
      for (const k of free) {
        const xd = [...x]; xd[k] += eps;
        const pd = project(input.model, poseAt(input.start, xd), input, visible);
        pairs.forEach(({ i }, row) => {
          const a = proj[i]!; const b = pd[i];
          J[row].push(b ? ((b.u - a.u) * a.nx + (b.v - a.v) * a.ny) / eps : 0);
        });
      }
      // Tukey weights: a match further than half the window is ignored.
      const c = window / 2;
      const n = free.length;
      const A = Array.from({ length: n }, () => new Array(n).fill(0));
      const g = new Array(n).fill(0);
      pairs.forEach(({ r }, row) => {
        const u = r / c;
        const w = Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0;
        if (w === 0) return;
        for (let a = 0; a < n; a++) {
          g[a] += w * J[row][a] * r;
          for (let b = 0; b < n; b++) A[a][b] += w * J[row][a] * J[row][b];
        }
      });
      // Levenberg damping keeps an ill-posed step (a part seen edge-on) from running away.
      // And a weak pull to the start: what the picture cannot show (a round
      // tank's turn, a facade's depth seen square on) stays where it was,
      // while anything the edges do show outweighs it by orders of magnitude.
      free.forEach((k, a) => { A[a][a] = A[a][a] * 1.05 + PRIOR; g[a] -= PRIOR * x[k]; });
      const step = solve(A, g);
      if (!step) return x;
      free.forEach((k, a) => { x[k] += step[a]; });
      if (Math.hypot(...step) < 1e-4) break;
    }
  }
  return x;
}

/** Parameters `x` moved by `along` metres on the assembly's own axes and turned by `turn`. */
function shifted(input: RegistrationInput, x: number[], along: [number, number], turn: number): number[] {
  const q = new Quaternion(...poseAt(input.start, x).rotation);
  const right = new Vector3(1, 0, 0).applyQuaternion(q); right.y = 0; right.normalize();
  const back = new Vector3(0, 0, 1).applyQuaternion(q); back.y = 0; back.normalize();
  const out = [...x];
  out[0] += right.x * along[0] + back.x * along[1];
  out[2] += right.z * along[0] + back.z * along[1];
  out[3] += turn;
  return out;
}

/** How well the model agrees with the picture at `pose`, as registration scores a fit. */
export function scorePose(input: RegistrationInput, pose: Pose): { share: number; visible: number; weakest: number } {
  return agreement(pose, input, AGREE_PX);
}

export function registerPose(input: RegistrationInput): RegistrationResult {
  const free = input.freedom === 'full' ? [0, 1, 2, 3, 4, 5] : [0, 2, 3];
  const windows = input.windows ?? [32, 20, 12, 7];
  const start = agreement(input.start, input, AGREE_PX);
  if (start.visible < MIN_VISIBLE) {
    return { pose: input.start, before: start.share, after: start.share, weakest: start.weakest, rival: 0, visible: start.visible, accepted: false, reason: 'too-few-visible' };
  }

  const x = refine(input, [0, 0, 0, 0, 0, 0], free, windows);
  // Rivals are near the fit, and seen as it is: its visibility serves them all,
  // and every candidate is scored on the same samples.
  const fitMask = visibility(input.model, poseAt(input.start, x), input);
  const fitShare = agreement(poseAt(input.start, x), input, AGREE_PX, fitMask).share;
  let best = { x, share: fitShare };

  // Rivals, refined from round the fit. A better one is taken; one nearly as good is ambiguity.
  const rivals: { x: number[]; share: number }[] = [];
  const offsets: [[number, number], number][] = [
    ...RIVAL_SHIFTS_M.flatMap((d) => [[[d, 0], 0], [[-d, 0], 0], [[0, d], 0], [[0, -d], 0]] as [[number, number], number][]),
    ...RIVAL_TURNS_RAD.flatMap((t) => [[[0, 0], t], [[0, 0], -t]] as [[number, number], number][]),
  ];
  for (const [along, turn] of offsets) {
    const rx = refine(input, shifted(input, x, along, turn), free, windows.slice(-2), fitMask);
    const share = agreement(poseAt(input.start, rx), input, AGREE_PX, fitMask).share;
    rivals.push({ x: rx, share });
    if (share > best.share) best = { x: rx, share };
  }
  const bestPose = poseAt(input.start, best.x);
  const bestVisible = visibility(input.model, bestPose, input);
  const bestProj = project(input.model, bestPose, input, bestVisible);
  const distinct = (a: number[]) => acrossPx(bestProj, poseAt(input.start, a), input) > DISTINCT_PX;
  const rival = [{ x, share: fitShare }, ...rivals]
    .filter((r) => distinct(r.x))
    .reduce((m, r) => Math.max(m, r.share), 0);

  const pose = bestPose;
  const end = agreement(pose, input, AGREE_PX, bestVisible);
  const moved = Math.hypot(best.x[0], best.x[1], best.x[2]);
  const turned = Math.hypot(best.x[3], best.x[4], best.x[5]);
  let reason: RegistrationResult['reason'];
  if (moved > Math.min(MAX_MOVE_M, MAX_MOVE_SIZES * modelSize(input.model)) || turned > MAX_TURN_RAD) reason = 'moved-too-far';
  else if (end.visible < Math.max(MIN_VISIBLE, MIN_KEPT * start.visible)) reason = 'too-few-visible';
  else if (end.share < MIN_AGREEMENT) reason = 'weak-fit';
  else if (end.weakest < MIN_WEAKEST) reason = 'lopsided';
  else if (end.share < start.share + MIN_GAIN) reason = 'no-improvement';
  else if (rival > best.share - RIVAL_MARGIN) reason = 'ambiguous';
  return {
    pose, before: start.share, after: end.share, weakest: end.weakest, rival, visible: end.visible,
    accepted: reason === undefined, ...(reason ? { reason } : {}),
  };
}
