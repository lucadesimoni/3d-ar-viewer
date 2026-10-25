# Architecture & roadmap

Where this app stands, why it is built the way it is, and what the next stages
are. The intent is that a newcomer can tell in five minutes which parts are
finished, which are honest approximations, and which do not exist yet.

Companion documents: [TODO.md](./TODO.md) for the concrete open items,
[README.md](./README.md) for how to run it, [COMPLIANCE.md](./COMPLIANCE.md)
for requirement traceability.

---

## The shape of the thing

```
              ┌──────────────────────────────────────────────┐
  camera ───► │ vision/      classical CV, then optionally ML │
              │   gridRecognition  facade → metric pose       │
              │   latticeTracker   follow it frame by frame   │
              │   pipeline         OpenCV + ONNX (optional)   │
              └───────────────┬──────────────────────────────┘
                              │ pose in camera space
              ┌───────────────▼──────────────────────────────┐
  sensors ──► │ engine/      pure geometry, no renderer       │
              │   snapping   mates, capture cones, residuals  │
              │   diagnostics fit, sequence, clash, keep-out  │
              │   alignment  registration, marker, plane      │
              │   tracking   capabilities, camera, marker     │
              └───────────────┬──────────────────────────────┘
                              │ state
              ┌───────────────▼──────────────────────────────┐
              │ state/store   one Zustand store, derived      │
              │               diagnostics on every mutation   │
              └───────────────┬──────────────────────────────┘
                              │ render state
              ┌───────────────▼──────────────────────────────┐
              │ render/babylon  SceneManager owns the scene   │
              │ components/     React owns the DOM, never a   │
              │                 3D frame                      │
              └──────────────────────────────────────────────┘
```

Four rules hold this together, and most of the bugs in this repo's history came
from breaking one of them:

1. **`engine/` never imports a renderer.** It is plain maths over plain data, so
   every geometric claim can be unit-tested without a canvas. three.js is a
   dependency there, used headlessly as a linear-algebra library only.
2. **React renders no 3D frames.** The store pushes a `SceneRenderState` into
   the `SceneManager`; the manager decides what that means for meshes.
3. **Everything degrades.** No OpenCV, no ONNX model, no WebXR, no camera — each
   absence removes a capability and breaks nothing. The geometry-driven app
   runs on a laptop with no hardware at all.
4. **Claims are measured, not asserted.** Anything that can only be seen in a
   running browser has a check script that asserts it in numbers — 160 checks
   on AR anchoring, tracking and the HUD, 84 on layout, 32 on the diagnostics
   log, 24 on the step guidance, 24 on the native-app bridge, 14 on placing
   and snapping, 14 on what a static host has to satisfy, 11 on operator
   notes, 7 on the self-hosted runtimes — alongside 725 unit tests.

---

## Stage 0 — what works today

| Area | State |
| --- | --- |
| Assembly model, mates, tolerances, sequence DAG | Done; five sample assemblies, invariant-tested at nominal |
| Snapping and fit verification | Done; drag a part, it seats on the joint or reports why not |
| Diagnostics | Fit, seating, sequence, interference (OBB SAT), keep-out, handed swap, missing part |
| Markerless object anchoring | Grid facade → metric pose, then frame-by-frame tracking |
| Lining up with the real object | Any assembly: edge registration refines a placement within ~20–30 px ([docs/RECOGNITION.md](./docs/RECOGNITION.md)) |
| AR on Android/Quest/visionOS | WebXR `immersive-ar` with hit-test and DOM overlay |
| AR on iOS Safari | Camera passthrough, gravity-derived floor, aim-and-tap, object tracking |
| Native apps (optional) | Android (ARCore) and iOS (ARKit) shells around the same web app, bridge protocol v1; built and tested in CI, **not yet run on a phone** ([native/README.md](./native/README.md)) |
| Camera step check | Edge check plus a small trained model per part of the active step ([docs/PRESENCE_MODEL.md](./docs/PRESENCE_MODEL.md)); not yet measured on a real build in progress |
| Marker re-registration | Planar homography from a QR of known size |
| Guidance | Step highlighting, on-part labels, per-step fly-in, exploded view |
| Co-presence | Protocol, session, annotations — over a loopback transport only |
| Delivery | PWA, service worker, `vercel.json`, offline app shell; tagged releases of every component (web archive, npm package, GHCR image, Mendix `.mpk`, Android APK, unsigned iOS IPA) |

---

## Stage 1 — next, in the order it is worth doing

### 1. The first session on a real phone
The native shells are built (`native/`): ARKit gives iPhone the world
tracking Safari lacks, and the Android app adds ARCore camera frames. Both pass
their unit tests, CI builds and, for Android, instrumented tests on an
emulator — but no phone has run either, and neither has the step check's
model or the alignment on a real build. One session answers the most:

1. install the APK (or the IPA, signed with a free Apple ID: SideStore,
   Sideloadly or Xcode);
2. enter AR, tap the floor, walk round the object, tick a step or two;
3. attach camera frames in AR settings and send the diagnostics log.

The log records the native session and tracking, every recognition and
alignment attempt with its reason, and each part's presence reading. What it
is expected to settle: why real frames do not line up (the reported camera
pose or field of view, see [docs/RECOGNITION.md](./docs/RECOGNITION.md)),
whether alignment's 30–180 ms on the main thread is a visible hitch (a worker
would remove it), and real crops to retrain the step check on.

Distribution beyond sideloading is a product decision, not a technical one:
TestFlight and the App Store need the paid Apple Developer Program, and the
Play Store a private signing key (the build already reads one from CI secrets).

### 2. Recognition backed by a model
The step check now ships a model (`perception/models/presence-v1.onnx`): it
says whether a part is where it should be. What is still missing is the other
question, *which* part is in the operator's hand: `vision/pipeline` speaks ONNX
Runtime Web and ships no detector, so a wrong board in the right slot reads as
present. Shipping one verified detector (with its labels and a licence that
permits redistribution), self-hosted rather than CDN, turns "wrong part in your
hand" from a demo into a feature.

### 3. A real transport for co-presence
`collab/session` is transport-agnostic and only a loopback exists. A WebSocket
relay (or WebRTC data channel with a signalling server) makes the second
headline feature real. The protocol is already sized for it: a few hundred bytes
per second, not video.

### 4. Asset pipeline
Parts are primitives or glTF today. A CAD path — STEP or a native format into
decimated glTF, with per-part metadata carried through — is what makes this
usable on anything other than the bundled samples. USDZ falls out of the same
pipeline and switches on AR Quick Look, which is currently dead code.

**Candidate for the conversion half: [fascat](https://github.com/pavelsimo/fascat)**
(MIT, Python 3.10+, `pip install fascat`). It reads STEP, IGES, OpenCASCADE BREP
and JT and writes OpenUSD, glTF/GLB, OBJ, STL and FBX, with the knobs this app
actually needs: tessellation tolerance (`--sag`, `--angle`, `--max-edge-length`),
mesh repair, material and UV staging, LOD generation and a triangle budget
(`--target-triangles`), plus `inspect` for a dry run and `validate` and
`--turntable-dir` renders to check an output before it ships. That is precisely
the server-side adapter step the README already describes as an export boundary
— it runs offline in a build job, never in the viewer.

What it does **not** give us, and what would still have to be written:

- **The manifest.** fascat converts geometry; `AssemblyDef` is occurrence ids
  that never collapse repeated bolts, `targetPose` in the viewer's left-handed
  Y-up metres, `sku`/`revision`, `source`, `bounds`. That mapping is ours, and
  it is where the import validation already has teeth.
- **Work instructions.** `steps`, `connectors` and tolerances are authored, not
  derived from a mesh — the rule the README states and this would not change.
- **USDZ.** fascat writes `.usdc`/`.usda`, not `.usdz`; Quick Look needs one
  more packaging step (`usdzip`) on top. Cheap, but not free, and the sentence
  above overstates it slightly today.
- **A budget we have measured.** The tablet log at 108 parts and 46 steps runs
  at 25 fps; `--target-triangles` and `--lods` are the levers for that, but the
  number to give them has to come from a device, not from taste.

Not started, and nothing depends on it yet. The bundled samples stay
hand-written (`src/data/`) until there is a real export to convert.

### 5. Rotation while placing
Dragging translates; a part that goes in the wrong way round can only be fixed
by the snap solver's own orientation correction. A two-finger rotate, and a
snap that reports orientation residual separately from position, complete the
placement story.

### 6. Measure alignment on a GLB assembly
Registration reads a loaded model's edges from its triangles
(`edgesFromTriangles`, `SceneManager.partEdges`), so a GLB assembly is lined
up like any other. It is unit-tested, but the benchmark
(`npm run recognition:bench`) has only assemblies built from primitives. Add
one made of GLB parts, including a rounded or scanned one: those have few
sharp edges and are expected to be refused more often. Until then there are
no numbers for GLBs.

### 7. Find any assembly from nothing
Only the KALLAX is found without help, by its grid of cells. Every other
assembly is placed by hand (a tap, WebXR, a marker), and registration then
corrects that placement if it is within its reach. Finding any assembly
from nothing means searching where it could stand on the floor and which
way it faces, scoring each candidate on the same edges, and refining the
best few. Ship it only if the benchmark shows it does not lock onto the wrong
thing: a wrong lock is worse than asking the operator to tap.

---

## Stage 2 — later, and why not yet

- **Perspective-tolerant recognition.** The lattice fit is axis-aligned and
  wants the facade within ~20° of square-on. Full line-segment detection with a
  vanishing-point solve lifts that, at a frame-budget cost that is not worth
  paying before stage 1.
- **Depth occlusion.** WebXR depth sensing would let real objects hide virtual
  ones properly, instead of the depth-only occluder proxies the samples declare.
- **Multiple objects in one scene.** Everything assumes one assembly and one
  anchor today.
- **Mendix in Studio Pro.** The widget ships as an `.mpk` with each release,
  load-tested in a host page; proving it in a Mendix app (and an editor
  preview) is what remains.
- **Localisation.** The interface is English only.

---

## Decisions worth knowing about

**Babylon.js for rendering, three.js for maths.** Babylon has first-class WebXR;
three.js has the tidier vector/quaternion API. The engine imports three
headlessly and never renders with it. Odd on paper, deliberate in practice.

**Grid recognition rather than a general detector.** A COCO-class detector tells
you there is furniture in frame, which is worth nothing to AR: you need the
outline and the scale. A regular grid facade gives both, and the pitch comes
from the BOM. It is a few milliseconds of plain JavaScript with no model
download, and it fails quietly rather than confidently.

**`approach` means where a part is brought in *from*.** The opposite reading is
just as natural and was in half the sample data, which is how parts came to fly
in through the assembly and the exploded view pushed them into it. The type
carries the definition now.

**Placement is a mode.** Armed while placing, disarmed once the assembly is
down. Left always-on, the reticle sits over the work and every stray tap moves
the workpiece.

**Browser checks over unit tests where the browser is the subject.** Anything
about layout, AR anchoring, tracking or service-worker behaviour is asserted in
a real browser against the real build. Unit tests cover the geometry, where they
are exact and fast.
