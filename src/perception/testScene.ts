import { Vector3 } from 'three';
import type { AssemblyDef, MeshSpec } from '../engine/types';
import type { CameraIntrinsics } from './intrinsics';

/**
 * Pictures whose truth is exact, for tests of registration: a few shapes
 * ray-cast into a small image, each face its own shade, on a floor and a
 * wall. The camera is built the way Babylon's view matrix is laid out (row
 * vectors, left-handed: x right, y up, z ahead), which is what `toViewSpace`
 * reads. Test code only.
 */
export const W = 320;
export const H = 240;
const FOV = 60;
const f = H / 2 / Math.tan((FOV * Math.PI) / 360);
export const K: CameraIntrinsics = { fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H, fovDeg: FOV, source: 'operator' };

export function camera(eye: Vector3, target: Vector3) {
  const forward = target.clone().sub(eye).normalize();
  const right = new Vector3(0, 1, 0).cross(forward).normalize();
  const up = forward.clone().cross(right);
  const view = [
    right.x, up.x, forward.x, 0,
    right.y, up.y, forward.y, 0,
    right.z, up.z, forward.z, 0,
    -right.dot(eye), -up.dot(eye), -forward.dot(eye), 1,
  ];
  return { eye, right, up, forward, view };
}

export interface Solid { mesh: MeshSpec; at: Vector3 }

/** Where a ray first meets a solid standing upright at `at`, and the normal there. */
function hit(o: Vector3, d: Vector3, s: Solid): { t: number; n: Vector3 } | undefined {
  const p = o.clone().sub(s.at);
  if (s.mesh.type === 'box') {
    const h = s.mesh.size.map((v) => v / 2);
    let near = -Infinity; let far = Infinity; let axis = 0; let sign = 1;
    for (let k = 0; k < 3; k++) {
      const pk = p.getComponent(k); const dk = d.getComponent(k);
      if (Math.abs(dk) < 1e-12) { if (Math.abs(pk) > h[k]) return undefined; continue; }
      const t1 = (-h[k] - pk) / dk; const t2 = (h[k] - pk) / dk;
      const lo = Math.min(t1, t2);
      if (lo > near) { near = lo; axis = k; sign = t1 < t2 ? -1 : 1; }
      far = Math.min(far, Math.max(t1, t2));
    }
    if (near > far || near < 0) return undefined;
    const n = new Vector3(); n.setComponent(axis, sign);
    return { t: near, n };
  }
  if (s.mesh.type === 'cylinder') {
    const { radius: r, height } = s.mesh;
    let best: { t: number; n: Vector3 } | undefined;
    const a = d.x * d.x + d.z * d.z; const b = 2 * (p.x * d.x + p.z * d.z); const c = p.x * p.x + p.z * p.z - r * r;
    const disc = b * b - 4 * a * c;
    if (a > 1e-12 && disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      const y = p.y + t * d.y;
      if (t > 0 && Math.abs(y) <= height / 2) best = { t, n: new Vector3(p.x + t * d.x, 0, p.z + t * d.z).normalize() };
    }
    for (const sy of [-1, 1]) {
      if (Math.abs(d.y) < 1e-12) continue;
      const t = ((sy * height) / 2 - p.y) / d.y;
      const x = p.x + t * d.x; const z = p.z + t * d.z;
      if (t > 0 && x * x + z * z <= r * r && (!best || t < best.t)) best = { t, n: new Vector3(0, sy, 0) };
    }
    return best;
  }
  throw new Error(`no ray cast for ${s.mesh.type}`);
}

/** The picture: each solid's faces shaded by their direction, a floor, a wall behind, and some noise. */
export function picture(solids: Solid[], cam: ReturnType<typeof camera>, noise = 4): ImageData {
  const data = new Uint8ClampedArray(W * H * 4);
  const light = new Vector3(0.4, 0.8, 0.5).normalize();
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const d = cam.right.clone().multiplyScalar((u + 0.5 - K.cx) / f)
        .addScaledVector(cam.up, -(v + 0.5 - K.cy) / f).add(cam.forward).normalize();
      let shade = 0.55; // the wall
      let t = Infinity;
      if (d.y < 0) { const tf = -cam.eye.y / d.y; if (tf < t) { t = tf; shade = 0.35; } }
      for (const s of solids) {
        const h = hit(cam.eye, d, s);
        if (h && h.t < t) { t = h.t; shade = 0.25 + 0.6 * Math.max(0, h.n.dot(light)); }
      }
      const i = (v * W + u) * 4;
      const g = shade * 255 + (rand() - 0.5) * 2 * noise;
      data[i] = g; data[i + 1] = g; data[i + 2] = g; data[i + 3] = 255;
    }
  }
  return new ImageData(data, W, H);
}

export function assemblyOf(solids: Solid[]): AssemblyDef {
  return {
    id: 'test', name: 'test', revision: '1', units: 'm', steps: [], background: [],
    defaultTolerance: { positionMm: 1, angleDeg: 1 },
    parts: solids.map((s, i) => ({
      id: `p${i}`, name: `p${i}`, mesh: s.mesh, connectors: [],
      targetPose: { position: [s.at.x, s.at.y, s.at.z], rotation: [0, 0, 0, 1] },
    })),
  } as unknown as AssemblyDef;
}
