# Changelog

Each version's section here is that release's notes: the release workflow
publishes it as written, and refuses to release a version that has none.
Sections are written automatically from what was merged (see
[docs/RELEASING.md](./docs/RELEASING.md)). Newest first. Versions follow
[semantic versioning](https://semver.org/).

## [Unreleased]

### The overlay lines itself up with the real object, for any assembly

- Every second or two in AR, the app matches the edges of the parts already
  built to the camera picture, and moves the overlay onto the object when the
  fit is clear. It works from the parts' shapes (boxes, plates, cylinders,
  tubes, spheres, and loaded 3D models), so it needs no recognition target.
  It refines the placement you have: a tap, a WebXR anchor, the shelf
  detector. It can be switched off in AR settings ("Line the overlay up with
  the real object").
- It refuses rather than guesses. A fit is used only when most of the model
  agrees with the picture all round its outline, and no other pose nearby fits
  nearly as well. Otherwise the overlay stays where it was.
- Measured on rendered views with known truth (docs/RECOGNITION.md): from a
  start off by 5 to 20 cm, it settles within a pixel or two on the shelves,
  the engine and the rack, with at most 2 visibly wrong moves in 96 tries per
  assembly and setting. The small gearbox is mostly out of its reach (3 wrong
  moves in 96) and is mostly left alone.
- **On real frames it has not yet helped.** On six device photos of KALLAX
  shelves, it refused every time: no pose standing on the floor fits those
  frames well, which points at the camera's reported pose or field of view
  rather than at the shelf. Every look is logged ("alignment look",
  "alignment moved the overlay") with why, so a device session will show it.
- Every shelf-detector attempt is logged with its outcome and why it failed,
  and a blank frame no longer produces a phantom shelf.

### Android app

- The page is told when ARCore has to be installed, instead of waiting; this
  failed the 0.5.0 release on the emulator.
- A crashed page reloads instead of closing the app.

## [0.5.0] — 2026-10-14

### Camera step check with a trained model

- A small model trained on synthetic renders (36k parameters, 147 KB, runs in
  the browser) checks each part of the active step from the camera. It works
  together with the existing edge check, and a vote counts only when the two
  do not contradict. See docs/PRESENCE_MODEL.md for how it was trained and how
  it scores: 96.9% on held-out renders, and no wrong votes on real KALLAX
  frames at the shipped thresholds. It is not yet measured on a real build in
  progress.
- The step guide says when every part of the step looks in place, or how many
  are not.
- Diagnostics captures record each part's outline and fitted state, so device
  reports become training data (`scripts/presence/crops-from-report.mjs`).

### Native apps (optional) and the PWA

- **Android app** (`spatial-ar-android-X.Y.Z.apk`): ARCore tracking and
  camera frames, with the same web app inside. Install the APK; the web app
  offers "Open in the Spatial AR app" when it is installed.
- **iOS app** (`spatial-ar-ios-X.Y.Z-unsigned.ipa`): ARKit world tracking,
  which Safari lacks. It is unsigned, so sign it with a free Apple ID (SideStore,
  Sideloadly, Xcode). See native/README.md.
- Both are tested by unit tests and CI builds, and the web app is tested
  against simulated shells. They are **not yet tested on a real phone**.
- The PWA installs properly on iOS and Android: PNG icons (iOS ignored the
  SVG), a maskable icon, and a complete manifest.

## [0.4.0] — 2026-10-14

- Self-hosted vision runtimes, error reports, privacy notice

## [0.3.1] — 2026-10-13

- Commercial licence contact in LICENSE and README

## [0.3.0] — 2026-10-13

- Free for noncommercial use, paid for commercial use (PolyForm Noncommercial 1.0.0)

## [0.2.0] — 2026-10-12

- Proprietary evaluation licence (Outthinkx); releases no longer published to public registries

## [0.1.1] — 2026-10-12

- The image compiles the app natively, never under QEMU
- Automatic releases retry cleanly and check the release commit first
- Automatic releases on every merge to main

## [0.1.0] — first release

The first packaged release of Spatial Assembly AR: guided assembly with an AR
overlay on phones and tablets, and the tooling that checks it.

### Components

- **Web app**: the static build, for any static host (`spatial-ar-web-0.1.0.zip`
  / `.tar.gz`). Also live at https://3d-ar-viewer-ten.vercel.app/.
- **Server**: `@lucadesimoni/spatial-ar-viewer`, the app plus a zero-dependency
  Node server, as an npm package with the `spatial-ar-viewer` command.
- **Container image**: `ghcr.io/lucadesimoni/3d-ar-viewer`, for linux/amd64 and
  linux/arm64, running as a non-root user with a health check.
- **Mendix widget** (preview): `anthropic.SpatialArViewer-0.1.0.mpk`, a
  pluggable widget wrapping the app. Packaged and load-tested against an AMD
  loader and ES modules, not yet imported into Studio Pro.

### What it does

- Assemblies with mates, tolerances and a step sequence; four samples: a bench
  gearbox, KALLAX shelves (4x2 and 4x4), a twin-spool turbofan, a 14-bay
  equipment rack.
- Snapping and fit checks: a dragged part seats on its joint or says why not;
  diagnostics for fit, seating, sequence, interference, keep-out and handedness.
- AR on Android (WebXR with hit-test, platform anchors and DOM overlay) and on
  iPhone/iPad Safari (camera passthrough, aim-and-tap); the Needle App Clip
  hosts the WebXR path on iOS.
- Markerless anchoring onto a cube shelf: grid facade to metric pose, then
  frame-by-frame tracking. A lattice read one row off is corrected by its
  outline, and in WebXR by the measured floor.
- A phone layout built for one hand: one sheet at a time, a step strip that
  follows the current step, actions that stay on screen.
- A diagnostics log every session can export, readable with
  `scripts/read-report.mjs`.
