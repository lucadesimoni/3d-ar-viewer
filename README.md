# Spatial Assembly AR

A web app for **spatial recognition and AR overlay of complex mechanical
assemblies**, built for iPad and iPhone. It guides an operator through an
assembly step by step, verifies each part as it goes in — position, orientation,
seating, sequence, interference, and left/right swaps — and lets a remote expert
join the *same spatial session* rather than watching a shaky screen-share.

> Why it beats a screen-sharing tool (TeamViewer et al.): those stream pixels of
> one person's screen. Here, both people are **in the same 3D scene**. Poses,
> placements and annotations sync as a few hundred bytes per second, each device
> renders the model against its own viewpoint, and the expert can look around the
> workpiece independently. That survives a factory-floor cellular link where
> video collapses.

## What it does

- **Guided assembly** — an ordered, dependency-aware step list with live status,
  per-step instructions, tools, cautions, and a time estimate.
- **Snapping & fit verification** — connectors are full 6-DoF frames, so every
  mate is checked for lateral/axial position, tilt, roll (with rotational
  symmetry), and seating depth against a tolerance band (ok / warn / fail).
- **Error detection** — interference (oriented-bounding-box SAT), out-of-sequence
  installs, keep-out intrusions, missing parts on a signed-off step, and the
  classic **handed-part swap** (left cap fitted in the right position).
- **Animation** — fly-in build animation in dependency order, per-step "show me",
  and an exploded view with a live spread slider.
- **Background geometry** — the bench and fixtures render as depth-only
  **occluders** so virtual parts correctly disappear behind real ones; keep-out
  volumes are drawn and enforced.
- **Registration** — 3-point (Horn's absolute orientation), 2-point + gravity,
  plane-drop, and automatic **marker re-registration** so the overlay re-locks
  onto the workpiece after the operator walks away and back.
- **Spatial co-presence** — shared session with participants, viewpoints and
  world-anchored annotations over a transport-agnostic protocol.

## Architecture

```
 camera frame
   └─ OpenCV.js      sharpness gate → illumination normalize → crop / perspective correct
        └─ ONNX Runtime Web   detection · segmentation · classification  (WebGPU→WASM)
             └─ engine (pure TS)   snapping · collision · diagnostics · sequencing · registration
                  └─ Babylon.js    rendering + native WebXR (immersive-ar)
                       └─ React     HUD, panels, mode bar
```

- **`src/engine/`** — the domain core, renderer-agnostic and fully unit-tested:
  `math`, `snapping`, `collision`, `diagnostics`, `sequencer`, `animation`,
  `alignment` (registration), plus `tracking/` (capability detection, iOS camera
  passthrough, marker homography pose) and `collab/` (the co-presence protocol
  and session). *`three` is a dependency here — used headless purely as a
  well-tested linear-algebra library; it does no rendering.*
- **`src/vision/`** — the recognition pipeline: `opencv` (OpenCV.js loader +
  preprocessing, with pure-JS fallbacks), `onnx` (ONNX Runtime Web wrapper with
  YOLO-style detection decode, NMS, softmax classify, argmax segment), and
  `pipeline` (orchestration, re-entrancy-guarded, expectation fusion).
- **`src/render/babylon/`** — Babylon.js `SceneManager`, mesh factory, and the
  native WebXR entry.
- **`src/components/`** — the React shell and HUD.
- **`src/state/`** — a Zustand store that derives diagnostics and the sequence
  view on every change.
- **`src/mendix/`** — a **Mendix pluggable-widget compatibility shim**
  (`SpatialArViewer`) plus its `.xml` manifest. This only *prepares*
  compatibility: it is structurally typed to compile without the Mendix SDK, is
  not imported by the standalone app, and is left out of the bundle. Full widget
  packaging (SDK types, build tooling, MPK output) is intended for later.

### Everything degrades gracefully

The heavy runtimes (Babylon aside) are **loaded lazily and are optional**. With
neither OpenCV nor an ONNX model present, the app is still a complete guided-AR
tool driven by geometry alone; each capability enriches the scene as it loads.
This keeps first paint fast on a cold connection while ~10 MB of WASM streams in
behind it. The status bar shows honest capability badges (HTTPS, WebGL2, WebXR,
Camera, OpenCV, ONNX).

## Performance & recognition

**Snapping / diagnostics performance.** The diagnostics engine re-runs on every
placement, so its hot paths are optimised for large assemblies:

- Interference broadphase is backed by a **uniform-grid spatial hash**
  (`src/engine/spatialHash.ts`), replacing the O(n²) pairwise sweep with a
  near-linear one — proven equivalent to brute force in tests. This is what keeps
  the 108-part rack responsive as parts are placed.
- Connector local frames are **memoised** by connector identity, removing the
  repeated matrix work they incurred (twice per mate, every diagnostics run).

**Object recognition accuracy & stability.** The vision pipeline does more than
run a model per frame:

- **Aspect-correct preprocessing** (`src/vision/preprocess.ts`): bilinear
  resampling and **letterboxing** instead of a nearest-neighbour squash, with
  detection boxes un-mapped back to the original frame. Squashing aspect ratio is
  one of the biggest silent accuracy killers for a detector; this fixes it.
- **Temporal fusion** (`src/vision/tracking.ts`): a SORT-style `DetectionTracker`
  associates detections across frames (IoU + EMA, hit/miss lifecycle) so boxes
  stop flickering and only *confirmed* parts drive the UI; a `ClassificationVoter`
  takes a rolling majority vote — important for the handed left/right pair, where
  a single frame flips. Temporal history resets on step change.
- **Soft-NMS** recovers a real overlapping part that hard NMS would delete —
  common in a dense assembly.
- **Colour-coded discrepancy — on the affected part**
  (`src/vision/verdict.ts`, `SceneManager`, `RecognitionOverlay.tsx`): a
  recognised object is highlighted *on its own geometry* in the registered
  overlay — **green** if it is the part the current step expects, **red** if it
  is a different known part (a wrong pick caught before it is even seated) —
  with a compact tag pinned to the part (via screen-space projection) and a
  verdict banner in words. The colour lands on the part area, not as a box over
  unrelated regions of the frame; unrecognised objects are left to the banner.

## Device support

| Device | Mode | How |
| --- | --- | --- |
| Android Chrome / Quest / Vision Pro | **WebXR immersive AR** | Babylon native, hit-test anchor drop, real occlusion |
| **iPhone / iPad (Safari)** | **Camera passthrough** | Rear camera + motion sensors; anchor by touching a datum; auto re-lock via QR marker |
| Any browser | 3D preview | Turntable view; everything except the camera works |
| iOS with a single model | AR Quick Look | System AR viewer fallback |

iOS Safari has **no WebXR**, so the camera-passthrough path is a first-class
citizen, not an afterthought — including 6-DoF marker pose recovery
(planar homography) so the overlay re-registers automatically.

## Flexible / embeddable UI

The UI reshapes from a full workstation down to a bare embeddable canvas — same
build, no separate embed bundle. A host picks the shape via a **preset**, then
individual **panel toggles**, then look controls (density, brand accent). Config
arrives three ways:

- **React prop** — `<App config={{ preset: 'minimal', accent: '#ff7a00' }} />`
  (this is how the Mendix widget passes `uiPreset` / `embedded` / `accent`).
- **URL params** — for an `<iframe>` embed, no code:
  `…/?ui=viewer&embedded=1&accent=%23ff7a00`, or granular
  `…/?panels=steps,diagnostics` and `…/?diagnostics=0&steps=1`.
- **Defaults** — full workstation.

Presets: `full` (everything) · `compact` (denser, no drawers/picker) ·
`minimal` (viewport + active-step guide + recognition) · `viewer` (bare canvas
with the on-part recognition tint only). See `src/ui/config.ts`.

```html
<!-- Drop the guided viewer into any page -->
<iframe src="https://your-host/?ui=minimal&embedded=1"
        style="width:100%;height:600px;border:0" allow="camera;xr-spatial-tracking"></iframe>
```

A live **embed demo** ships with the build at **`/embed-demo.html`** — it hosts
the app in an iframe with switches for every preset, panel, density and accent,
and shows the URL to copy. Run `npm start` (or `npm run serve`) and open
`http://localhost:8080/embed-demo.html`.

## Versioning & BOM

Every part carries a **clean revision** (`revision`, plus optional
`revisionDate` / `supersedes`) — aerospace letter revisions (A < B < … < AA) or
dotted numeric, ordered and compared by `src/engine/versioning.ts`. From that:

- a **Bill of Materials** (one line per part number *and* revision, quantities
  and mass rolled up), shown in-app under the **BOM** tab;
- an assembly **content fingerprint** — a stable build id derived from every
  part's revision, so an as-built record traces to exactly the versions fitted;
- a **wrong-revision** relation (`revisionRelation`) that distinguishes a
  superseded (older) part from a newer one — the dangerous shop-floor case.

## Running

```bash
npm install
npm run dev         # http://localhost:5173

# On a device, AR needs a secure context (camera + sensors):
npm run dev -- --https   # or tunnel the port behind a trusted cert
```

```bash
npm test            # unit tests across engine + vision + versioning
npm run typecheck
npm run build       # production bundle
```

### Run the packaged app

The build is served by a **zero-dependency Node server** — no framework, no
extra install — so a built copy runs anywhere Node 20+ runs:

```bash
npm start                      # build, then serve on http://0.0.0.0:8080
npm run serve                  # serve an existing ./dist
PORT=3000 npm run serve
node server/serve.mjs --isolate   # COOP/COEP headers for multi-threaded ONNX WASM
```

Or as a container:

```bash
docker build -t spatial-ar .
docker run -p 8080:8080 spatial-ar
```

AR on a device needs a secure context — pass `--https --cert cert.pem --key
key.pem`, or put the server behind a TLS-terminating proxy / tunnel.

### Plugging in recognition models

No model weights are bundled — the app ships small and runs fully geometry-only
until you supply a model. The **best public starting point for industrial AR** is
**Ultralytics YOLO (YOLO11 / YOLOv8)** exported to ONNX: real-time, WebGPU-
accelerated in ONNX Runtime Web, and the pipeline's decoder already handles its
output (`src/vision/defaultModels.ts`, COCO-80 labels bundled; both YOLOv5 and
YOLOv8/YOLO11 output formats are decoded, auto-detected).

It recognises **generic** objects, not your specific parts. For real part
recognition, fine-tune on a few hundred labelled images and name the classes
after your part IDs (so the on-part discrepancy overlay maps 1:1), export to
ONNX, host it, and set `VITE_DETECTOR_MODEL_URL` (see `.env.example`). A stock
model can be mapped to parts for a demo via `remapLabels`.

### GPU acceleration — per device

- **Rendering** uses **WebGPU** where the device supports it (Safari 26+, modern
  Chrome/Edge/Android) for lower CPU overhead, and falls back automatically to
  **WebGL2** — then WebGL1, then a software rasteriser — so it is GPU-accelerated
  on every device with a GPU (`src/render/babylon/engineFactory.ts`,
  `powerPreference: high-performance`). The status bar shows the *live* backend
  (`GPU · WebGPU` / `WebGL2 (GPU)` / `Software (no GPU)` …). Force the WebGL path
  with `?gpu=webgl`.
- **ML inference** uses the **WebGPU** execution provider where available (fast),
  falling back to multi-threaded **WASM** (CPU) — so recognition runs everywhere,
  just faster where WebGPU exists (modern Android/desktop, and iOS/iPadOS with
  Safari 26+).

## Sample assemblies

Two are bundled; switch between them with the picker at the top of the step
guide.

- **`src/data/gearbox.ts`** — a small worked two-stage bench gearbox (11 parts)
  that exercises every diagnostic: a handed pair of bearing caps (the swap trap),
  a keyed shaft (roll matters), bolts that must follow their housing, a keep-out
  volume over the output shaft, and a strict six-step build order. The best place
  to read how the model works.
- **`src/data/equipmentRack.ts`** — a **large** 14-bay modular equipment rack
  (108 parts, 46-step dependency graph) that stresses the app at scale: handed
  left/right rail pairs on every bay (swap detection ×14), a rear cable-channel
  keep-out, background floor/wall occluders, and enough geometry to exercise the
  renderer, the exploded view, and the full-build animation. It is generated by a
  joint helper so all ~110 parts fit cleanly at nominal, verified in tests.

## Requirements compliance

See [COMPLIANCE.md](./COMPLIANCE.md) for a traceability matrix mapping every
requirement from the brief to where it is implemented and how it is verified.

## Production & performance

**Maximum performance on every device.** On startup the renderer detects a device
tier (cores, memory, GPU renderer, texture limits — `src/render/perf.ts`) and
picks a profile: pixel-ratio cap, antialias, target FPS, and recognition cadence.
On top of that, Babylon's `SceneOptimizer` **auto-degrades under live load** —
if the scene can't hold the target frame rate it lowers internal resolution
until it can, so a heavy assembly stays smooth on a weak tablet instead of
stuttering. Static background geometry is frozen and per-move picking is off.
Override for benchmarking/kiosk tuning: `?perf=low|mid|high|max`, `?dpr=1.5`,
`?fps=30`.

**Production server.** `server/serve.mjs` adds gzip (cached by mtime), a
`/healthz` liveness probe, `immutable` caching for fingerprinted `/assets/*`,
`no-cache` for HTML, and a `Permissions-Policy` granting the camera/AR sensor
features (no `X-Frame-Options`, so it stays embeddable). Multi-threaded ONNX WASM
via `--isolate` (COOP/COEP). The Dockerfile has a `HEALTHCHECK`.

**Offline-capable PWA.** A web app manifest makes it installable (standalone,
full-screen — good for a tablet kiosk), and a service worker caches the app
shell (stale-while-revalidate) so it opens and runs offline on flaky shop-floor
Wi-Fi; the geometry-driven app works without the CDN model bundles.

**Going to production**
- Serve over **HTTPS** (required for camera / sensors / WebXR): `--https --cert
  cert.pem --key key.pem`, or a TLS-terminating proxy / tunnel.
- Self-host the ONNX/OpenCV WASM and set `ort.env.wasm.wasmPaths` /
  `loadOpenCV(url)` to your origin if you can't reach the CDN, then run with
  `--isolate` for threaded inference.
- Supply your trained ONNX model URLs and map the model's class labels to part
  IDs so the on-part discrepancy overlay fires.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests + build on every push.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).
