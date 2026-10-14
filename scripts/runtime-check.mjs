/**
 * The heavy runtimes come from the app's own origin, and run.
 *
 * OpenCV.js, ONNX Runtime's wasm and the Draco glTF decoder used to be fetched
 * from docs.opencv.org and cdn.jsdelivr.net. On a network that blocks CDNs,
 * which the networks this is used on do, recognition quietly lost OpenCV, and
 * nothing third-party could be cached for offline use. And the Draco decoder
 * was pointed at the wrong files: a Draco-compressed model never decoded at all,
 * and nothing checked it. So each is loaded here by the app's own code and made
 * to do real work: OpenCV builds a matrix, ONNX Runtime runs a model, a
 * Draco-compressed part appears in the scene. And no request may leave the
 * app's origin while it happens.
 *
 * Usage: node scripts/runtime-check.mjs   (with the app served on PREVIEW_URL)
 */
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { launchOptions } from './chrome.mjs';
import { createChecks, PREVIEW_URL } from './checks.mjs';

const URL = PREVIEW_URL;
const { check, finish } = createChecks();
const require = createRequire(import.meta.url);

// --- Fixtures, built here rather than committed as opaque binaries. ---------

/** Protobuf, just enough of it for an ONNX graph. */
const varint = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const field = (no, wire, bytes) => [...varint((no << 3) | wire), ...(wire === 2 ? varint(bytes.length) : []), ...bytes];
const str = (no, s) => field(no, 2, [...Buffer.from(s)]);
const num = (no, n) => field(no, 0, varint(n));
const msg = (no, ...parts) => field(no, 2, parts.flat());

/** y = Identity(x), x and y float[1]: the smallest model that has to run. */
function identityModel() {
  const tensor = (name) => [...str(1, name), ...msg(2, msg(1, num(1, 1), msg(2, msg(1, num(1, 1)))))];
  const graph = [
    ...msg(1, str(1, 'x'), str(2, 'y'), str(4, 'Identity')),
    ...str(2, 'identity'),
    ...msg(11, tensor('x')),
    ...msg(12, tensor('y')),
  ];
  return Uint8Array.from([...num(1, 8), ...msg(8, str(1, ''), num(2, 13)), ...msg(7, graph)]);
}

/** A unit cube as a glTF binary, its mesh Draco-compressed (KHR_draco_mesh_compression). */
async function dracoCube() {
  const { createEncoderModule } = require('draco3dgltf');
  // The module is itself thenable, so awaiting it directly never settles:
  // unwrap it inside a plain object.
  const { draco } = await new Promise((resolve) => createEncoderModule({}).then((m) => resolve({ draco: m })));
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]);
  const mesh = new draco.Mesh();
  const builder = new draco.MeshBuilder();
  builder.AddFacesToMesh(mesh, indices.length / 3, indices);
  const positionId = builder.AddFloatAttributeToMesh(mesh, draco.POSITION, positions.length / 3, 3, positions);
  const encoder = new draco.Encoder();
  const out = new draco.DracoInt8Array();
  const length = encoder.EncodeMeshToDracoBuffer(mesh, out);
  const bin = Buffer.alloc(Math.ceil(length / 4) * 4);
  for (let i = 0; i < length; i++) bin[i] = out.GetValue(i);
  for (const o of [out, encoder, builder, mesh]) draco.destroy(o);
  if (!length) throw new Error('the Draco encoder produced nothing');

  const gltf = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_draco_mesh_compression'],
    extensionsRequired: ['KHR_draco_mesh_compression'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{
      attributes: { POSITION: 0 }, indices: 1,
      extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: positionId } } },
    }] }],
    accessors: [
      { componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
      { componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: length }],
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (type, body) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(body.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, body]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
}

const cube = await dracoCube();

const browser = await chromium.launch(launchOptions());
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const page = await context.newPage();
const ownOrigin = new globalThis.URL(URL).origin;
const offsite = [];
page.on('request', (r) => {
  const { origin, protocol } = new globalThis.URL(r.url());
  if (protocol.startsWith('http') && origin !== ownOrigin) offsite.push(r.url());
});
const runtimeRequests = [];
page.on('response', (r) => {
  if (/opencv|ort-wasm|draco/i.test(r.url())) runtimeRequests.push(`${r.status()} ${r.url()}`);
});
// The fixture is served as if it were the deployment's own model file.
await page.route('**/__fixtures/draco-cube.glb', (route) => route.fulfill({
  status: 200, contentType: 'model/gltf-binary', body: cube,
}));

await page.goto(`${URL}?assembly=bench-gearbox`, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas.viewer-canvas');
await page.waitForFunction(() => (window.spatialScene?.()?.renderStats().frames ?? 0) > 0, undefined, { timeout: 20000 });

// --- OpenCV. ------------------------------------------------------------------
const opencv = await page.evaluate(async () => {
  const cv = await window.spatialRuntimes.opencv();
  if (!cv) return { ok: false, why: 'loadOpenCV resolved nothing' };
  const m = new cv.Mat(3, 4, cv.CV_8UC1);
  const ok = m.rows === 3 && m.cols === 4;
  m.delete();
  return { ok, why: `Mat ${ok ? '3x4' : 'wrong shape'}` };
});
const opencvFrom = runtimeRequests.filter((r) => /opencv/i.test(r));
check('OpenCV loads and runs', opencv.ok, opencv.why);
check('from this origin', opencvFrom.length > 0 && opencvFrom.every((r) => r.startsWith('200 ') && r.includes(ownOrigin)),
  opencvFrom.join(', ') || 'never requested');

// --- ONNX Runtime. ------------------------------------------------------------------
const onnx = await page.evaluate(async (bytes) => {
  const ort = await window.spatialRuntimes.onnx();
  if (!ort) return { ok: false, why: 'loadOrt resolved nothing' };
  try {
    const session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] });
    const out = await session.run({ x: new ort.Tensor('float32', Float32Array.of(4.25), [1]) });
    const y = out.y?.data?.[0];
    await session.release();
    return { ok: y === 4.25, why: `Identity(4.25) = ${y}` };
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error).slice(0, 200) };
  }
}, [...identityModel()]);
const ortFrom = runtimeRequests.filter((r) => /ort-wasm/i.test(r));
check('ONNX Runtime loads its wasm and runs a model', onnx.ok, onnx.why);
check('from this origin', ortFrom.length > 0 && ortFrom.every((r) => r.startsWith('200 ') && r.includes(ownOrigin)),
  ortFrom.join(', ') || 'never requested');

// --- Draco. ---------------------------------------------------------------------
const partId = await page.evaluate(() => {
  const { assembly, loadAssembly } = window.spatialStore.getState();
  const next = structuredClone(assembly);
  next.parts[0].mesh = { type: 'url', url: '/__fixtures/draco-cube.glb', draco: true };
  loadAssembly(next);
  return next.parts[0].id;
});
const drawn = await page.waitForFunction((id) => {
  const meshes = window.spatialScene?.()?.parts?.get(id)?.loadedMeshes ?? [];
  return meshes.reduce((n, m) => n + (m.getTotalVertices?.() ?? 0), 0) >= 8;
}, partId, { timeout: 20000 }).then(() => true, () => false);
const dracoFrom = runtimeRequests.filter((r) => /draco_decoder/i.test(r));
check('a Draco-compressed model decodes into the scene', drawn,
  drawn ? `part ${partId}` : `part ${partId} kept its placeholder`);
check('with the decoder from this origin', dracoFrom.length > 0 && dracoFrom.every((r) => r.startsWith('200 ') && r.includes(ownOrigin)),
  dracoFrom.join(', ') || 'never requested');

check('and nothing was fetched from anywhere else', offsite.length === 0,
  [...new Set(offsite)].slice(0, 4).join(', ') || 'none');

await browser.close();
finish('the runtimes are self-hosted and work');
