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

### Compared with TeamViewer Assist AR, honestly

TeamViewer Assist AR is a native app built on **ARKit and ARCore**, with 3D
annotations placed on a live video feed, OCR and session summaries, and support
for industrial smart glasses. Two of those are structural advantages we cannot
match from a browser, and the rest is a different product to a different problem.

| | TeamViewer Assist AR | This app |
| --- | --- | --- |
| Tracking | ARKit / ARCore visual-inertial odometry, native | WebXR (which *is* ARCore) on Android, Quest and visionOS Safari; on iPhone/iPad Safari there is no WebXR, so: gravity, tap-to-place, and frame-by-frame visual tracking of the recognised object |
| What it knows about the object | Nothing — a human expert draws on the video | The CAD assembly: parts, mates, tolerances, build sequence, keep-outs |
| What the overlay does | Shows where the expert pointed | Verifies fit as parts go in: position, tilt, roll, seating, sequence, interference, handed swaps |
| Anchoring | Feature map from ARKit/ARCore | Detected plane; **or the object itself**, recognised markerlessly with metric scale |
| Needs a remote expert | Yes, that is the product | No — it works solo; co-presence is an option on top |
| Install | App Store / Play, MDM rollout | A URL |
| Glasses | RealWear, Vuzix, Epson | Android-based glasses run the same URL; untested by us |

**The honest gap:** on iPhone and iPad there is no way to reach ARKit from
Safari. What we have instead is object tracking, not world tracking: while the
recognised object is in shot the overlay follows it frame by frame (see above),
which covers the case that matters for guided assembly. Look away from it and
there is nothing holding the anchor — ARKit would keep it from the room's
feature map. Closing *that* means a thin native wrapper around a WKWebView with
an ARKit plugin. On Android and Quest, WebXR gives us the same ARCore tracking
they use.

**Where the trade goes the other way:** an ARKit anchor knows where a surface is
but not what is standing on it. Because the model, the mates and the tolerances
are in the app, this can tell an operator that the left bearing cap is fitted on
the right, or that step 7 was skipped — which is not something a drawing on a
video feed can do, no matter how good the tracking underneath it is.

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
- **Anchoring that finds the world, not the screen** — WebXR hit-test on a real
  plane where the device has it; **markerless object recognition** of the
  assembly's own facade (see below); QR marker re-registration; and, on iOS,
  aim-and-tap on the floor plane implied by gravity. It never drops the model at
  a guessed standoff and calls that AR.
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
| **iPhone / iPad (Safari)** | **Camera passthrough** | Rear camera + motion sensors; aim-and-tap floor placement, object recognition, auto re-lock via QR marker |
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

## Deploying

The repo ships `server/serve.mjs` for a container or a shop-floor box, and a
`vercel.json` for a static host. They set the same things: `Permissions-Policy`
for camera and sensors, immutable caching for the fingerprinted bundles,
no-cache for the HTML shell and the service worker, and deliberately **no**
`X-Frame-Options`, so the app stays embeddable.

A static host is not the same environment as the bundled server, and one failure
only appears on the *second* deployment: a service worker that serves its cached
HTML shell hands the browser an index.html from the previous build, whose
fingerprinted bundles no longer exist. That is a blank screen, and nothing local
reproduces it. So `npm run deploy:check` serves the real build from a directory
it swaps underneath a headless browser and walks the sequence a user actually
gets — first visit, offline visit, visit after a redeploy, offline again:

```
npm run build && npm run deploy:check
```

The service worker is split accordingly: `/assets/*` is cache-first (the names
are fingerprinted, so a cached copy cannot be stale), everything else is
network-first with a 3 s timeout and a cached fallback. It also precaches the
bundles named by `index.html` at install, because on a first visit the worker is
not yet controlling the page and would otherwise cache a shell whose scripts it
never stored — offline that looks fine right up until it has to work.

> Upgrading from an earlier deployment: a device that already registered the
> previous worker gets one stale load before the new one takes over. One reload
> fixes it; there is no way to avoid that from the new build, which is the point
> of not shipping the old policy in the first place.

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

## Anchoring: floor, object, marker

The app tries these in order, and tells the operator which one it is using:

| Source | Where it works | How |
| --- | --- | --- |
| **WebXR hit-test** | Android, Quest, Vision Pro | The device reports a real plane; the reticle sits on the true floor and the anchor is world-locked. The session is entered by the app itself and the HUD is composited over the camera through `dom-overlay`; if the session is refused for any reason the app falls back to camera passthrough rather than showing a transparent canvas over a black page. |
| **Object recognition** | Everywhere the camera works | The assembly's own facade is found in the frame by `src/vision/gridRecognition.ts`, giving a full metric pose — no marker, no setup. |
| **QR marker** | Assemblies that ship a fiducial | Planar homography from four corners; the most precise of the four. |
| **Aim and tap** | iOS Safari (no WebXR) | Gravity plus an assumed eye height defines the floor; the tap lands the assembly at a true distance. |

Everything hangs off one anchor node, so whichever source wins, **the whole
assembly moves with it** and the parts stay aligned to each other and snapped to
their mates.

### Following it once it is recognised

Detection on its own updates the anchor once or twice a second, which is fine
for a shelf that stays put and useless for an operator who moves: the overlay
freezes between answers. So a lock is handed to `vision/latticeTracker`, which
follows the lattice intersections from frame to frame by normalised
cross-correlation — coarse pass at half resolution to cover fast motion, fine
pass to land sub-pixel — and refits the homography every frame.

Three details are what make it hold rather than slide:

- after each frame the points are snapped back onto the fitted homography, so
  per-point error cannot accumulate — the object's own rigid geometry is the
  correction, and points briefly lost behind a hand come back on their own;
- points that moved unlike the rest are dropped before the fit, and a fit whose
  surviving points do not span three rows and three columns is refused outright,
  because points confined to two lines leave the perspective unconstrained and
  will happily produce a confident wrong pose on a repeating pattern;
- beyond its motion budget it lets go and re-detects instead of matching
  something that merely looks similar.

Cost is about 3 ms per frame at 480x360, against 2.4 ms for a full detection —
so speed is not really the point. The point is continuity, and that tracked
points feed a *full* homography: the detector needs the facade roughly
square-on, whereas once the lock exists it survives the operator walking round
to an oblique view.

### Recognising an object without a marker

A generic object detector tells you *that* there is furniture in the frame,
which is worth nothing to AR — you need the outline and the scale. A regular
grid facade gives both: the openings are identical, so their pitch is a number
straight out of the BOM. `gridRecognition` projects gradient energy onto each
axis, peak-picks the board lines, and fits a periodic lattice by exhaustive
search over spacing and phase, scored by inliers minus missing lines. Clutter in
one bay adds a stray peak that simply does not fit the lattice. It is a few
milliseconds of plain JavaScript, deterministic, and it needs no model download.
The facade must be roughly square-on (within ~20°), which is how you stand in
front of a shelf anyway.

## Placing a part, and the snap

Drag a part in the 3D view and let go: the drag runs on a plane through the
part's centre facing the camera, and only the release is committed, so the snap
solver sees one decision rather than sixty intermediate ones. Within capture
range (60 mm / 35°) the part seats itself on the joint; outside it, the part
stays where it was dropped and the diagnostics say why — that is the difference
between an assist and a lie. The step card's **Place** does the same thing for
the whole step at once, from each part's standoff, so the residuals mean
something; the first part of an assembly has nothing to snap to and is simply
put where it belongs.

`npm run place:check` drives this with a real pointer: a part released 38 mm off
its joint must end at 0 mm from nominal with a recorded snap, and one dropped
140 mm out must stay out and raise `NOT_ENGAGED`.

## What the guidance looks like

The step card tells you what to fit; the 3D view has to tell you *which parts*,
and the two must not have to be read against each other:

- The active step's parts are highlighted and every other part is dimmed to a
  ghost.
- Each highlighted part carries **its own name, pinned to it** and projected
  every frame. Four identical shelves in a row would produce four overlapping
  labels, so a tag is dropped when it would land on one already placed and the
  remainder is reported as a count.
- **Show me** plays that step's parts flying in along their approach direction,
  staggered in the order they go in — which is what shows *how* a part goes in
  and which way round it is. It is a demonstration: placements are untouched and
  the view returns to exactly what it was.

`npm run steps:check` asserts all three against every step of every bundled
assembly: that each label belongs to the step it is shown for, that "Show me"
moves the step's own parts and no others, and that it changes nothing.

> A part's `approach` is **where it is brought in from** — a board dropped from
> above is `[0, 1, 0]`. The opposite reading is just as natural and was in half
> the sample data, which is why parts used to fly in *through* the assembly and
> the exploded view pushed them into it. The type carries the definition now.

## The AR view on a phone or tablet

In AR the camera image *is* the interface, so the desktop layout is put away
entirely — no header, no side columns, no bottom bar. What is left is a single
thumb-height HUD over the live view:

- the current step, always visible, with prev/next arrows;
- **Steps**, **Errors** and **View** open the corresponding panel in a sheet
  that covers under half the screen and closes with the same button;
- **Move** goes back to aiming at the floor, to re-place the assembly — because
  placement is a *mode*, not a permanent state. The reticle appears while you
  are placing and goes away once the assembly is down, and a tap after that is
  someone touching the screen rather than a request to move the workpiece.
  Whether AR asks for a placement at all on entry is a setting: turn it off and
  it opens where you left it;
Leaving AR hands the camera back to the system — the tracks are stopped *and*
the `<video>` element is detached, because an element still holding a dead
stream is enough for the next `getUserMedia` on Android to come back
`NotReadableError: Could not start video source`. Teardown is fault-tolerant
step by step, so nothing can leave the app convinced it is still in a session it
has left. And in AR the overlay is a reference registered to a real workpiece,
not a model to manipulate: dragging and selecting parts are off there, because a
stray touch was quietly placing parts and opening an inspector over the
guidance.

When AR cannot start, the app says so. A denied camera used to make the button
do nothing at all, which is indistinguishable from a broken build; now the
reason is on screen, and the placement badge names which path is running —
WebXR, or the camera fallback.

- **Settings** holds the placement behaviour above and the two numbers the
  browser will not tell us — the camera's
  field of view and how high the device is being held. Both are live: drag the
  FOV slider until the overlay matches the real object, drag the height until
  the reticle sits on the real floor. `?camfov=52` pre-sets the first.

Every control is at least 48 px tall, the bar is capped at 760 px wide so it
stays under the thumb on a 13-inch iPad, and the canvas takes `touch-action:
none` so a tap places the assembly instead of scrolling the page. The screen is
held awake for the session — a tablet that dims mid-step drops the camera feed
and the anchor with it.

Outside AR a phone gets **one** bottom bar — steps, errors, view modes, the
register/collaborate/BOM drawers, and the way into AR — each opening the same
sheet. It used to be three stacked bars plus floating drawer tabs over the
model, which left the 3D view a letterbox on a 390 px screen.

Two layout rules exist specifically because of iOS Safari:

- **The HUD is a normal flex child of a `100dvh` column, never `position:
  fixed`.** iOS resolves a fixed element against the *layout* viewport — the
  tall one that exists when the toolbars are hidden — so a bar anchored to its
  bottom sits behind the toolbar on a real iPhone while every desktop viewport
  looks perfect. `npm run ar:verify` asserts the computed position and that the
  HUD's bottom edge is inside the viewport.
- **The way into AR lives in the bottom nav on a phone, not in the header.** In
  the header it is one long assembly name away from being pushed off the edge,
  and the top of the screen is the worst place to reach one-handed.

The overlay is rendered at the field of view **actually visible** rather than
the camera's own: the video is painted with `object-fit: cover`, so a 4:3 frame
in a landscape tablet loses about 7% of its height, and drawing at the uncropped
FOV would shrink the whole overlay by the same amount. It is recomputed on every
resize, because rotating an iPad changes which axis gets cropped.

## Sample assemblies

Three are bundled; switch between them with the picker at the top of the step
guide, or open one directly with `?assembly=kallax-4x4`.

- **`src/data/gearbox.ts`** — a small worked two-stage bench gearbox (11 parts)
  that exercises every diagnostic: a handed pair of bearing caps (the swap trap),
  a keyed shaft (roll matters), bolts that must follow their housing, a keep-out
  volume over the output shaft, and a strict six-step build order. The best place
  to read how the model works.
- **`src/data/kallax.ts`** — a 4x4 cube shelf (20 parts, 8 steps) modelled on
  the IKEA KALLAX 147 x 147 cm, so the AR path can be tested against a real
  object that is actually in people's homes. Its facade is the markerless
  recognition target. Dimensions are derived from the two published numbers
  (1470 mm across, 330 mm opening ⇒ 30 mm board) rather than guessed, so the
  model and the joints cannot drift apart.
- **`src/data/equipmentRack.ts`** — a **large** 14-bay modular equipment rack
  (108 parts, 46-step dependency graph) that stresses the app at scale: handed
  left/right rail pairs on every bay (swap detection ×14), a rear cable-channel
  keep-out, background floor/wall occluders, and enough geometry to exercise the
  renderer, the exploded view, and the full-build animation. It is generated by a
  joint helper so all ~110 parts fit cleanly at nominal, verified in tests.

## Testing

[docs/TESTING.md](./docs/TESTING.md) lays out the five layers — types, unit,
browser, deployment, production — what each one can prove, and the checklist of
things that need a human with a phone because a headless browser has no camera
optics, no gyroscope and no WebXR device.

## Where this is going, and what is missing

[ROADMAP.md](./ROADMAP.md) has the architecture, the rules that hold it
together, and the staged plan. [TODO.md](./TODO.md) is the honest list of gaps,
stated approximations (assumed camera intrinsics, assumed eye height,
axis-aligned recognition) and things that cannot be verified without hardware.

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
