/**
 * Synthetic training images for the presence model, rendered in the browser.
 *
 * Built and driven by `generate.mjs`. Each call renders one view of one
 * assembly part-way through its build, in a randomised room, and cuts a
 * training crop for every part the app would ask about from that view:
 * through the app's own projection (`roi.ts`, `contour.ts`), eligibility
 * (`eligibility.ts`) and crop (`presenceInput.ts`), so the training crops are
 * the runtime's crops. The label is whether the part was rendered.
 *
 * What is randomised, and why, from the real frames the model has to work on:
 *  - the finish of the boards (white most often, as on the real KALLAX), the
 *    floor (wood planks, tiles, carpet, concrete) and the wall;
 *  - clutter in the cubes: baskets, boxes and books stand in most cells of a
 *    real shelf, and things stand on top of it;
 *  - light: colour, strength, direction, with and without shadows;
 *  - the camera: where an operator holds a phone, its field of view, and
 *    what a phone does to a picture (noise, blur, exposure, JPEG);
 *  - the anchor: the outline is projected through a pose a few centimetres and
 *    degrees off the true one, as a real anchor is.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Quaternion as BQuaternion, Vector3 as BVector3 } from '@babylonjs/core/Maths/math.vector';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Ray } from '@babylonjs/core/Culling/ray';
import '@babylonjs/core/Culling/ray';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Quaternion, Vector3 } from 'three';
import { ASSEMBLIES } from '../../src/data';
import { KALLAX_4X2_DIMENSIONS, KALLAX_DIMENSIONS } from '../../src/data/kallax';
import { buildMesh } from '../../src/render/babylon/meshFactory';
import { meshHalfExtents } from '../../src/engine/collision';
import type { AssemblyDef, PartDef } from '../../src/engine/types';
import { roiForBox } from '../../src/perception/roi';
import { partContour } from '../../src/perception/contour';
import { checkEligibility } from '../../src/perception/eligibility';
import { cameraIntrinsics } from '../../src/perception/intrinsics';
import { cropToRgba, presenceCrop } from '../../src/perception/presenceInput';

// --- Randomness, seeded so a shard can be regenerated. -------------------------
let seed = 1;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const range = (a: number, b: number) => a + (b - a) * rand();
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const chance = (p: number) => rand() < p;

// --- Procedural textures. ------------------------------------------------------
type Painter = (g: CanvasRenderingContext2D, s: number) => void;
const hsl = (h: number, s: number, l: number) => `hsl(${h} ${s}% ${l}%)`;

const speckle = (g: CanvasRenderingContext2D, s: number, n: number, alpha: number) => {
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(${chance(0.5) ? '0,0,0' : '255,255,255'},${rand() * alpha})`;
    g.fillRect(rand() * s, rand() * s, 1 + rand() * 3, 1 + rand() * 3);
  }
};

const FLOORS: Painter[] = [
  (g, s) => { // wood planks
    const h = range(25, 40); const l = range(35, 70);
    const plank = s / Math.round(range(4, 9));
    for (let y = 0; y < s; y += plank) {
      g.fillStyle = hsl(h + range(-4, 4), range(30, 55), l + range(-8, 8));
      g.fillRect(0, y, s, plank);
      for (let k = 0; k < 40; k++) {
        g.strokeStyle = `rgba(60,30,10,${rand() * 0.15})`;
        g.beginPath(); const yy = y + rand() * plank; g.moveTo(0, yy);
        g.bezierCurveTo(s / 3, yy + range(-3, 3), (2 * s) / 3, yy + range(-3, 3), s, yy + range(-2, 2)); g.stroke();
      }
      g.fillStyle = 'rgba(30,15,5,0.5)'; g.fillRect(0, y, s, 1.5);
      for (let x = rand() * s; x < s; x += range(s / 3, s)) g.fillRect(x, y, 1.5, plank);
    }
  },
  (g, s) => { // tiles
    const t = s / Math.round(range(3, 8)); const base = hsl(range(0, 360), range(0, 25), range(40, 85));
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.strokeStyle = hsl(0, 0, range(20, 90)); g.lineWidth = range(1, 4);
    for (let p = 0; p <= s; p += t) { g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.moveTo(0, p); g.lineTo(s, p); g.stroke(); }
    speckle(g, s, 1500, 0.08);
  },
  (g, s) => { // carpet or concrete
    g.fillStyle = hsl(range(0, 360), range(0, 40), range(25, 75)); g.fillRect(0, 0, s, s);
    speckle(g, s, 9000, 0.18);
  },
];

const WALLS: Painter[] = [
  (g, s) => { g.fillStyle = hsl(range(0, 360), range(0, 20), range(60, 95)); g.fillRect(0, 0, s, s); speckle(g, s, 3000, 0.04); },
  (g, s) => { // a wall with a picture or a window-ish bright patch
    g.fillStyle = hsl(range(0, 360), range(0, 30), range(50, 90)); g.fillRect(0, 0, s, s);
    g.fillStyle = hsl(range(0, 360), range(0, 70), range(10, 95));
    g.fillRect(range(0, s * 0.7), range(0, s * 0.5), range(s * 0.1, s * 0.35), range(s * 0.1, s * 0.35));
  },
];

/** Board finishes, weighted the way furniture is sold: white most of all. */
function boardFinish(): Painter {
  const r = rand();
  if (r < 0.5) { const l = range(84, 97); return (g, s) => { g.fillStyle = hsl(range(30, 60), range(0, 12), l); g.fillRect(0, 0, s, s); speckle(g, s, 400, 0.03); }; }
  if (r < 0.65) { return (g, s) => { g.fillStyle = hsl(range(10, 30), range(10, 30), range(8, 20)); g.fillRect(0, 0, s, s); speckle(g, s, 600, 0.05); }; }
  if (r < 0.85) { // oak / birch effect
    const h = range(28, 40); const l = range(55, 78);
    return (g, s) => {
      g.fillStyle = hsl(h, range(30, 50), l); g.fillRect(0, 0, s, s);
      for (let k = 0; k < 80; k++) {
        g.strokeStyle = `rgba(90,50,20,${rand() * 0.12})`; g.beginPath();
        const y = rand() * s; g.moveTo(0, y); g.bezierCurveTo(s / 3, y + range(-6, 6), (2 * s) / 3, y + range(-6, 6), s, y); g.stroke();
      }
    };
  }
  return (g, s) => { g.fillStyle = hsl(range(0, 360), range(0, 50), range(25, 80)); g.fillRect(0, 0, s, s); speckle(g, s, 400, 0.05); };
}

const CLUTTER: Painter[] = [
  (g, s) => { // woven basket
    g.fillStyle = hsl(range(25, 40), range(30, 55), range(40, 65)); g.fillRect(0, 0, s, s);
    const w = range(4, 9);
    for (let y = 0; y < s; y += w) for (let x = (y / w) % 2 ? 0 : w; x < s; x += 2 * w) {
      g.fillStyle = `rgba(60,30,10,${range(0.15, 0.4)})`; g.fillRect(x, y, w, w);
    }
  },
  (g, s) => { g.fillStyle = hsl(range(0, 360), range(20, 90), range(20, 80)); g.fillRect(0, 0, s, s); speckle(g, s, 500, 0.1); },
  (g, s) => { // book spines
    let x = 0; while (x < s) { const w = range(s / 30, s / 10); g.fillStyle = hsl(range(0, 360), range(20, 80), range(15, 75)); g.fillRect(x, 0, w, s); x += w; }
  },
];

let scene: Scene; let engine: Engine; let canvas: HTMLCanvasElement;

function texturedMaterial(name: string, painter: Painter, size = 256, uv = 1): StandardMaterial {
  const tex = new DynamicTexture(`${name}-tex`, { width: size, height: size }, scene, true);
  painter(tex.getContext() as unknown as CanvasRenderingContext2D, size);
  tex.update();
  tex.uScale = uv; tex.vScale = uv;
  const mat = new StandardMaterial(name, scene);
  mat.diffuseTexture = tex;
  mat.specularColor = new Color3(1, 1, 1).scale(range(0, 0.25));
  return mat;
}

/** A part's oriented box in world space: the runtime's `SceneManager.partBox`. */
function boxOf(part: PartDef, mesh: Mesh, root: TransformNode) {
  mesh.computeWorldMatrix(true);
  const bb = mesh.getBoundingInfo().boundingBox;
  const c = bb.centerWorld;
  const rotation = new BQuaternion();
  root.getWorldMatrix().decompose(undefined, rotation, undefined);
  const he = meshHalfExtents(part.mesh);
  return { center: [c.x, c.y, c.z] as [number, number, number], halfExtents: [he.x, he.y, he.z] as [number, number, number], rotation: [rotation.x, rotation.y, rotation.z, rotation.w] as [number, number, number, number] };
}

/** The same box seen through an anchor that is off by `error` (a rigid transform about `pivot`). */
function throughAnchorError(box: ReturnType<typeof boxOf>, error: { t: Vector3; q: Quaternion }, pivot: Vector3) {
  const c = new Vector3(...box.center).sub(pivot).applyQuaternion(error.q).add(pivot).add(error.t);
  const q = error.q.clone().multiply(new Quaternion(...box.rotation));
  return { center: [c.x, c.y, c.z] as const, halfExtents: box.halfExtents, rotation: [q.x, q.y, q.z, q.w] as const };
}

export interface Sample { rgba: string; present: boolean; partId: string; assembly: string; stage: number; areaFraction: number; distanceM: number }

/** Bytes to base64, in chunks the call stack can take. */
function b64(bytes: Uint8ClampedArray): string {
  let s = ''; for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(s);
}

/** Cells of a KALLAX, for clutter: centre and opening, in its own frame. */
function kallaxCells(assembly: AssemblyDef) {
  const d = assembly.id.includes('4x2') ? KALLAX_4X2_DIMENSIONS : assembly.id.includes('kallax') ? KALLAX_DIMENSIONS : undefined;
  if (!d) return [];
  const cells: { x: number; y: number; z: number; o: number }[] = [];
  const pitch = d.openingM + d.boardT;
  for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) {
    cells.push({ x: -d.widthM / 2 + d.boardT + d.openingM / 2 + c * pitch, y: d.boardT + d.openingM / 2 + r * pitch, z: 0, o: d.openingM });
  }
  return cells;
}

export async function render(opts: { seed: number; width: number; height: number }): Promise<Sample[]> {
  seed = opts.seed;
  if (!engine) {
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, antialias: true });
  }
  canvas.width = opts.width; canvas.height = opts.height;
  engine.resize(true);
  scene?.dispose();
  scene = new Scene(engine);
  scene.clearColor = new Color4(0.8, 0.8, 0.8, 1);

  // --- The assembly, part-way through its build. ---------------------------
  const kallaxes = ASSEMBLIES.filter((a) => a.id.includes('kallax'));
  const assembly = chance(0.8) ? pick(kallaxes) : pick(ASSEMBLIES.filter((a) => !a.id.includes('kallax')));
  const steps = assembly.steps;
  // Stage = steps complete; the step after it is partly done.
  const stage = Math.floor(rand() * (steps.length + 1));
  const installed = new Set<string>();
  steps.slice(0, stage).forEach((s) => s.partIds.forEach((p) => installed.add(p)));
  if (stage < steps.length) steps[stage].partIds.forEach((p) => { if (chance(0.5)) installed.add(p); });
  const unsequenced = new Set(assembly.parts.map((p) => p.id)); steps.forEach((s) => s.partIds.forEach((p) => unsequenced.delete(p)));
  unsequenced.forEach((p) => installed.add(p));

  const root = new TransformNode('assembly', scene);
  const yaw = range(-0.25, 0.25);
  root.rotationQuaternion = BQuaternion.RotationYawPitchRoll(yaw, 0, 0);
  const boardMats = [texturedMaterial('board', boardFinish())];
  if (chance(0.3)) boardMats.push(texturedMaterial('board2', boardFinish()));
  const meshes = new Map<string, { part: PartDef; mesh: Mesh; node: TransformNode }>();
  for (const part of assembly.parts) {
    if (part.mesh.type === 'url') continue;
    const node = new TransformNode(`p-${part.id}`, scene);
    node.parent = root;
    node.position.set(...part.targetPose.position);
    node.rotationQuaternion = new BQuaternion(...part.targetPose.rotation);
    const mesh = buildMesh(scene, part.mesh, `mesh-${part.id}`);
    mesh.parent = node;
    mesh.material = assembly.id.includes('kallax') ? pick(boardMats) : texturedMaterial(`m-${part.id}`, boardFinish(), 64);
    mesh.setEnabled(installed.has(part.id));
    meshes.set(part.id, { part, mesh, node });
  }

  // --- The room. --------------------------------------------------------------
  const floor = CreateGround('floor', { width: 14, height: 14 }, scene);
  floor.material = texturedMaterial('floor', pick(FLOORS), 512, range(2, 6));
  // Behind the assembly: right against a shelf's back, as a real one stands, or further off.
  const backZ = Math.min(...assembly.parts.map((p) => p.targetPose.position[2] - meshHalfExtents(p.mesh).length()));
  const wallZ = Math.min(-0.2, backZ) - range(0.005, 0.6);
  const wall = CreatePlane('wall', { width: 14, height: 5 }, scene);
  wall.position.set(0, 2.5, wallZ); wall.rotation.y = Math.PI;
  wall.material = texturedMaterial('wall', pick(WALLS), 256, 1);
  if (chance(0.4)) { // a side wall
    const side = CreatePlane('side', { width: 8, height: 5 }, scene);
    side.position.set(pick([-1, 1]) * range(1.2, 3), 2.5, 2); side.rotation.y = side.position.x > 0 ? Math.PI / 2 : -Math.PI / 2;
    side.material = texturedMaterial('side', pick(WALLS));
  }
  const clutter: AbstractMesh[] = [];
  const allInstalled = assembly.parts.every((p) => installed.has(p.id));
  // In the cubes, mostly once the shelf is built; something on top or beside it.
  for (const cell of kallaxCells(assembly)) {
    if (!chance(allInstalled ? 0.65 : 0.2)) continue;
    const o = cell.o * range(0.75, 0.95);
    const box = CreateBox('clutter', { width: o, height: o * range(0.5, 0.95), depth: o * range(0.5, 0.95) }, scene);
    box.parent = root;
    box.position.set(cell.x, cell.y - cell.o / 2 + (o * 0.5 * range(0.5, 0.95)) + 0.002, -range(0, 0.04));
    box.material = texturedMaterial('cl', pick(CLUTTER), 128);
    clutter.push(box);
  }
  for (let i = 0, n = Math.floor(range(0, 6)); i < n; i++) {
    const s = range(0.1, 0.5);
    const m = chance(0.6) ? CreateBox('stuff', { width: s, height: s * range(0.3, 2), depth: s }, scene)
      : CreateCylinder('stuff', { diameter: s * 0.6, height: s * range(0.5, 2) }, scene);
    m.position.set(range(-2.5, 2.5), (m.getBoundingInfo().boundingBox.extendSize.y), range(-0.3, 2.5));
    m.material = texturedMaterial('st', pick(CLUTTER), 64);
    clutter.push(m);
  }

  // --- Light. ----------------------------------------------------------------
  const hemi = new HemisphericLight('hemi', new BVector3(range(-0.3, 0.3), 1, range(-0.3, 0.3)), scene);
  hemi.intensity = range(0.5, 1.1);
  hemi.diffuse = Color3.FromHSV(range(20, 60), range(0, 0.25), 1);
  hemi.groundColor = new Color3(1, 1, 1).scale(range(0.1, 0.5));
  const sun = new DirectionalLight('sun', new BVector3(range(-1, 1), -range(0.4, 1), range(-1, 0.2)), scene);
  sun.position = sun.direction.scale(-6);
  sun.intensity = range(0, 1.2);
  if (chance(0.5) && sun.intensity > 0.3) {
    const sg = new ShadowGenerator(1024, sun);
    sg.useBlurExponentialShadowMap = true;
    for (const { mesh } of meshes.values()) sg.addShadowCaster(mesh);
    clutter.forEach((m) => sg.addShadowCaster(m));
    floor.receiveShadows = true; wall.receiveShadows = true;
    for (const { mesh } of meshes.values()) mesh.receiveShadows = true;
  }

  // --- The operator's phone. ----------------------------------------------------
  const extent = assembly.parts.reduce((m, p) => Math.max(m, Math.hypot(...p.targetPose.position)), 0.2);
  const size = Math.max(0.3, extent);
  const centre = new BVector3(0, size * 0.45, 0);
  const azimuth = range(-1.1, 1.1) + yaw;
  // Where people stand to check their work: from arm's length to across the room.
  const distance = Math.min(2.6, size * range(1.0, 2.2) + 0.3);
  const camera = new FreeCamera('cam', new BVector3(
    Math.sin(azimuth) * distance, range(0.6, 1.8), Math.cos(azimuth) * distance + 0.05,
  ), scene);
  camera.fov = (range(55, 75) * Math.PI) / 180;
  camera.minZ = 0.05;
  camera.setTarget(centre.add(new BVector3(range(-0.2, 0.2) * size, range(-0.2, 0.2) * size, 0)));
  // Roll: a phone is not held level.
  camera.rotation.z += (range(-8, 8) * Math.PI) / 180;
  scene.activeCamera = camera;

  await scene.whenReadyAsync();
  scene.render();

  // --- What the phone does to the picture. ----------------------------------------
  const out = document.createElement('canvas'); out.width = opts.width; out.height = opts.height;
  const g = out.getContext('2d', { willReadFrequently: true })!;
  g.filter = `brightness(${range(0.65, 1.35)}) contrast(${range(0.75, 1.25)}) saturate(${range(0.6, 1.4)}) blur(${chance(0.5) ? range(0, 1.1) : 0}px)`;
  g.drawImage(canvas, 0, 0);
  g.filter = 'none';
  const raw = g.getImageData(0, 0, out.width, out.height);
  const sigma = range(0, 8);
  for (let i = 0; i < raw.data.length; i += 4) {
    const n = gauss() * sigma;
    raw.data[i] += n; raw.data[i + 1] += n; raw.data[i + 2] += n;
  }
  g.putImageData(raw, 0, 0);
  const jpeg = await new Promise<Blob>((ok) => out.toBlob((b) => ok(b!), 'image/jpeg', range(0.55, 0.92)));
  const bitmap = await createImageBitmap(jpeg);
  g.drawImage(bitmap, 0, 0);
  const image = g.getImageData(0, 0, out.width, out.height);

  // --- One crop per part the app would ask about. ----------------------------------
  const view = scene.getViewMatrix().asArray();
  const k = cameraIntrinsics({ frame: image, operatorFovDeg: (camera.fov * 180) / Math.PI });
  // Half the views with a good lock, half with the larger error real locks
  // were measured to have on device frames (several centimetres, a few degrees).
  const loose = chance(0.5);
  const sT = loose ? 0.03 : 0.012; const sR = loose ? 3 : 1.2;
  const error = {
    t: new Vector3(gauss() * sT, gauss() * sT * 0.7, gauss() * sT).clampLength(0, 0.08),
    q: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (gauss() * sR * Math.PI) / 180)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (gauss() * sR * 0.6 * Math.PI) / 180))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (gauss() * sR * 0.6 * Math.PI) / 180)),
  };
  const pivot = new Vector3(0, 0, 0);
  const samples: Sample[] = [];
  for (const { part, mesh, node } of meshes.values()) {
    mesh.setEnabled(true); // measured whether drawn or not
    const truth = boxOf(part, mesh, node);
    mesh.setEnabled(installed.has(part.id));
    const believed = throughAnchorError(truth, error, pivot);
    const roi = roiForBox(believed, view, k);
    // Occluded, as the runtime decides it: an installed part between camera and centre.
    const origin = camera.globalPosition;
    const target = new BVector3(...truth.center);
    const toward = target.subtract(origin); const dist = toward.length();
    const hit = scene.pickWithRay(new Ray(origin, toward.scale(1 / dist), dist), (m) => m.isEnabled() && m.name.startsWith('mesh-') && m.name !== `mesh-${part.id}`);
    const eligibility = checkEligibility({
      hasTarget: true, anchored: true, roi, sharp: true, trackingReady: true,
      explodeFactor: 0, occluded: Boolean(hit?.hit && hit.distance < dist - 0.01), frameUniform: false,
    });
    if (!eligibility.eligible) continue;
    const contour = partContour({
      center: new Vector3(...believed.center), halfExtents: new Vector3(...believed.halfExtents),
      rotation: new Quaternion(...believed.rotation),
    }, view, k);
    if (!contour || contour.hull.length < 3) continue;
    const crop = presenceCrop(image, contour.hull);
    if (!crop) continue;
    samples.push({
      rgba: b64(cropToRgba(crop)), present: installed.has(part.id), partId: part.id, assembly: assembly.id,
      stage, areaFraction: roi!.areaFraction, distanceM: roi!.distanceM,
    });
  }
  return samples;
}

(window as unknown as { synth: { render: typeof render } }).synth = { render };
