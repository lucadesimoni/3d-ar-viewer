# Open items

Honest list of what is unfinished, approximate, or unverified. Ordered by how
much it costs a user. See [ROADMAP.md](./ROADMAP.md) for where these sit in the
larger plan.

Legend: **gap** = missing capability · **approximation** = works, with a stated
error · **unverified** = correct as far as it can be tested here · **chore**.

---

## Blocking a real deployment

- **gap — no ONNX model ships.** `vision/pipeline` is wired for detection,
  classification and segmentation; with no `VITE_DETECTOR_MODEL_URL` set it runs
  geometry-only and stays quiet. Pick a model with a redistributable licence,
  self-host it, ship its labels. `src/vision/defaultModels.ts`
- **chore — OpenCV.js is loaded from `docs.opencv.org`.** That is a
  documentation site, not a CDN: no SRI, ~8 MB, and a single point of failure
  behind a corporate firewall. Self-host it or pin a real CDN with an integrity
  hash. Everything degrades gracefully when it fails to load, which is why this
  has not bitten yet. `src/vision/opencv.ts`
- **gap — AR Quick Look never appears.** The button requires `quickLookUrl` on
  the assembly and no sample ships a USDZ, so on iOS the escape hatch is dead
  code. Needs the asset pipeline (roadmap 1.4). `src/components/QuickLookButton.tsx`
- **chore — home-screen icons are SVG only.** iOS ignores an SVG
  `apple-touch-icon`, so an installed PWA gets a screenshot instead of an icon.
  Needs 180/192/512 px PNGs in the manifest. `public/manifest.webmanifest`

## Approximations that are stated, and should eventually stop being approximate

- **approximation — camera intrinsics are assumed.** No browser exposes the real
  calibration, so a 60° vertical FOV is assumed and corrected for the visible
  crop. A 5° error is roughly a 10% range error, which is why recognition
  re-registers rather than measures. The AR settings sheet exposes the number,
  and `?camfov=` presets it. `src/engine/tracking/markerTracking.ts`
- **approximation — eye height is assumed** (1.45 m) for the iOS floor plane.
  Adjustable live in AR settings; there is no way to measure it from the web.
- **approximation — grid recognition is axis-aligned.** The facade must be
  within ~20° of square-on to be *acquired*; once tracking, a full homography
  holds it at oblique angles. `src/vision/gridRecognition.ts`
- **approximation — the lattice phase can be half a board out.** A board has two
  edges; which family the fit locks onto shifts the rectangle's centre by up to
  half a board (15 mm on a KALLAX). Span, and therefore scale and range, are
  unaffected.
- **approximation — dragging translates only.** No rotation gesture yet; the
  snap solver supplies orientation when a mate catches. (roadmap 1.5)

## Unverified without hardware

- **unverified — device-orientation axis convention.** The correction quaternion
  between the sensor frame and the scene has only been exercised against
  synthetic input; a real phone is the test. `SceneManager.setDeviceOrientation`
- **gap — a device that reports no orientation at all.** Some Android browsers
  fire neither `deviceorientation` nor `deviceorientationabsolute` without a
  user gesture or a flag. The app now says so on screen and placement still
  works (the assembly goes straight ahead at a bounded distance), but the
  overlay cannot follow the phone, which is most of the point of AR.
  `src/engine/tracking/cameraTracker.ts`
- **unverified — WebXR session entry on a headset.** Entering, the DOM overlay
  and the hit-test reticle are asserted only through the refusal path in CI
  (which must fall back to the camera). Android phones have been tested by hand.
- **unverified — performance tiering on a real iPad.** The device tier decides
  pixel ratio, target frame rate and recognition interval; a software renderer
  reports `low` here, so the `high` path is untested in anger. `src/render/perf.ts`

## Product gaps

- **gap — co-presence has no transport.** `LoopbackTransport` only: two tabs on
  one machine can share a session, two people cannot. (roadmap 1.3)
  `src/engine/collab/session.ts`
- **gap — no world tracking on iOS.** The overlay holds while the recognised
  object is in shot and nothing anchors it once you look away. (roadmap 1.1)
- **gap — one assembly, one anchor.** No support for several tracked objects in
  a scene.
- **gap — English only.** No i18n layer; strings are inline in components.
- **gap — Mendix widget is prepared, not packaged.** Compiles, excluded from the
  bundle, no `.mpk`. `src/mendix/`

## Known field behaviour worth keeping an eye on

- The camera is released when the tab is hidden and re-acquired on return, and
  a busy camera is retried once before it is reported. Both exist because
  `NotReadableError: Could not start video source` on Android usually means
  another tab of this same app is holding the device, not that anything is
  broken. If it keeps happening, look for a second tab first.
- Placement distance is bounded by the assembly's own size (eight bounding
  radii, 1.2–8 m). A tap near the horizon used to put a 260 mm gearbox twenty
  metres away, which looked exactly like "placed, but nothing rendered".

## Engineering chores

- **chore — the entry bundle is 1.6 MB** (425 kB gzipped). Splitting Babylon out
  was measured and rejected — it pulls the lazily-loaded shaders into one eager
  chunk and makes first paint worse. Lazy-loading the whole renderer behind the
  shell is the version that would actually help. `vite.config.ts`
- **chore — `autoPlaceActiveStep` and `placeActiveStepFromStandoff` overlap.**
  The first teleports parts to nominal (used by the screenshot script), the
  second brings them in through the snap solver (used by the UI). One of them
  should go. `src/state/store.ts`
- **chore — no accessibility pass.** Focus rings and roles are in place; nothing
  has been through a screen reader.
- **chore — `/healthz` exists only on the bundled server**, not on a static
  host, so uptime monitoring of the Vercel deployment has to hit `/`.

---

## How to check you have not broken any of this

```
npm run typecheck && npm test        # 161 unit tests, geometry and vision
npm run build && npm run serve &     # then, against the real build:
npm run ar:verify                    # 42 checks: AR anchoring, tracking, HUD
npm run steps:check                  # 12 checks: step labels and animation
npm run place:check                  # 7 checks: placing and snapping
npm run deploy:check                 # 8 checks: static host, offline, redeploy
```

CI runs all of it on every push to `main` and every pull request.
