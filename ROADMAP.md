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
   running browser has a check script that asserts it in numbers — 42 checks on
   AR anchoring, tracking and the HUD, 12 on the step guidance, 7 on placing and
   snapping, 8 on the deployed-app behaviours a static host has to satisfy. CI
   runs all four on every push, alongside 161 unit tests.

---

## Stage 0 — what works today

| Area | State |
| --- | --- |
| Assembly model, mates, tolerances, sequence DAG | Done; three sample assemblies, invariant-tested at nominal |
| Snapping and fit verification | Done; drag a part, it seats on the joint or reports why not |
| Diagnostics | Fit, seating, sequence, interference (OBB SAT), keep-out, handed swap, missing part |
| Markerless object anchoring | Grid facade → metric pose, then frame-by-frame tracking |
| AR on Android/Quest/visionOS | WebXR `immersive-ar` with hit-test and DOM overlay |
| AR on iOS Safari | Camera passthrough, gravity-derived floor, aim-and-tap, object tracking |
| Marker re-registration | Planar homography from a QR of known size |
| Guidance | Step highlighting, on-part labels, per-step fly-in, exploded view |
| Co-presence | Protocol, session, annotations — over a loopback transport only |
| Delivery | PWA, service worker, `vercel.json`, offline app shell |

---

## Stage 1 — next, in the order it is worth doing

### 1. World tracking on iOS
The one structural gap. Safari exposes no WebXR, so the overlay holds only while
the recognised object is in shot; look away and nothing anchors it. Closing it
means a thin native shell — WKWebView plus an ARKit plugin that feeds poses into
the same store — which changes distribution (App Store, MDM) and so is a product
decision, not only a technical one. Everything above the anchor already works
against an injected pose, so the surface area is small.

### 2. Recognition backed by a model
`vision/pipeline` speaks ONNX Runtime Web and nothing ships a model, so out of
the box recognition is geometric. Shipping one verified detector (with its
labels and a licence that permits redistribution), self-hosted rather than CDN,
turns "wrong part in your hand" from a demo into a feature.

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

### 5. Rotation while placing
Dragging translates; a part that goes in the wrong way round can only be fixed
by the snap solver's own orientation correction. A two-finger rotate, and a
snap that reports orientation residual separately from position, complete the
placement story.

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
- **Mendix packaging.** The widget compiles and is excluded from the bundle;
  finishing it is packaging work, deliberately deferred.
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
