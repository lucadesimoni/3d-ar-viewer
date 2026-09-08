# Testing this end to end

Five layers, from the ones a machine runs unattended to the one that needs a
human holding a phone. Each says what it can prove and, more usefully, what it
cannot.

| Layer | Command | Covers | Blind to |
| --- | --- | --- | --- |
| Types | `npm run typecheck` | The whole repo compiles | Everything about behaviour |
| Unit | `npm test` | Geometry, assembly import, iframe protocol, camera lifecycle, recognition identity and inference lifecycle, snapping, diagnostics, sequencing, vision maths | Real camera optics, device GPU/sensors, and browser layout |
| Browser | `ar:verify`, `steps:check`, `layout:check`, `place:check` | AR anchoring and tracking, the HUD on phone/tablet viewports, step guidance, placing and snapping — against a real Chromium and the real build | Real camera optics, real motion sensors, real WebXR |
| Deployment | `deploy:check` | First visit, offline, redeploy with new bundle names, offline again — against a deliberately dumb static host | Whether the actual host sets the headers |
| Production | the same browser checks with `PREVIEW_URL=https://…` | The site that is actually serving: bad deploy, stale worker, missing header | Same hardware blind spots |

CI runs layers 1–4 on every push and pull request, and layer 5 nightly and on
demand (Actions ▸ CI ▸ Run workflow).

## Running the lot locally

```bash
npm run typecheck && npm test
npm run build
npm run serve &                 # http://localhost:8080
npm run ar:verify               # 74 checks
npm run steps:check             # 12 checks
npm run layout:check            # 19 checks
npm run place:check             # 7 checks
npm run deploy:check            # 8 checks — starts its own host
```

Against the deployed site instead of a local build:

```bash
PREVIEW_URL=https://your-deployment.example/ npm run ar:verify
```

## What the browser checks actually do

Focused platform regressions also cover external assembly validation and
occurrence identities (`assemblyImport.test.ts`), origin-checked host messages
and private-resource cache routing (`src/embed/`), Mendix validation/configuration
and completion events, and same-id CAD revision updates in the scene manager.
Camera tests simulate late permission/playback completion; recognition tests
simulate model outputs, failures, class mappings and invalidated in-flight work.
These do not measure production recognition accuracy against real parts.

They are not smoke tests. Each asserts a number or a state that a person
reported wrong at some point:

- **`ar:verify`** enters AR with a fake camera, taps to place, and measures
  where the assembly landed in metres; injects a synthetic cube shelf as the
  camera feed and requires the app to recognise it, anchor upright, and *follow*
  it as it pans (17+ anchor updates in two seconds, largest step under 60 mm);
  fakes a device that advertises WebXR but refuses the session and requires a
  live camera rather than a black screen; fakes a busy camera and requires one
  retry then an explanation; walks place → stray tap → Move → re-place → Exit →
  re-enter, checking the camera is handed back; and asserts the HUD is laid out
  in flow rather than fixed, because on iOS a fixed bar sits behind Safari's
  toolbar.
- **`steps:check`** walks every step of every bundled assembly and requires each
  on-part label to belong to that step, and "Show me" to animate that step's own
  parts and change nothing.
- **`layout:check`** opens the start screen at four viewports — phone in both
  orientations, tablet, desktop — and requires the assembly to actually fill the
  frame, the 3D view to keep its share of the screen, the page never to scroll,
  and every control to be on screen and at least 32 px tall. It exists because
  the camera framed each assembly together with its workbench, so a 0.26 m
  gearbox was drawn 11% of the screen wide: nothing failed, the app just looked
  empty.
- **`place:check`** drags a part with a real pointer and requires it to snap
  from 38 mm out to 0 mm from nominal — and, dropped 140 mm out, to *stay* out
  and raise a diagnostic.
- **`deploy:check`** serves the build from a directory it swaps underneath the
  browser, reproducing the blank screen a stale service worker causes after a
  redeploy.

## The part no machine can do

The XR unit regressions in `xrSession.test.ts`, `xrPlacement.test.ts`, and
`useArController.test.ts` cover first-frame startup, native selection independent
of scene picking, HUD input suppression, world-relative reference-space requests,
and camera-to-XR handoff cleanup. They use simulated sessions, not ARCore.

A headless Chromium has a fake camera, no gyroscope, no compass, and no WebXR
device. These need a person and a phone, and there is no honest way around it:

- [ ] **Camera passthrough** — the real image appears behind the overlay.
- [ ] **Motion** — turning the phone turns the overlay with it. (Some Android
      browsers report no orientation at all; the app says so on screen. If you
      see "No motion sensor", that is the device, not the app.)
- [ ] **Aim and tap** — the reticle sits on the actual floor, and the assembly
      lands where you tapped, at a believable size.
- [ ] **Scale** — measure the real object, compare with the overlay. The camera
      field of view is assumed; the AR settings sheet has the slider.
- [ ] **Object recognition** — point it at a 4×4 cube shelf; the badge should
      read "Locked onto the 4x4 cube shelf front", and the overlay should stay
      on it as you walk sideways.
- [ ] **WebXR** (Android/Quest) — the session enters, the HUD stays visible over
      the camera, the anchor holds when you walk around it.
- [ ] **WebXR placement** — aim at a detected surface, tap the viewport, then
      walk sideways. The assembly stays on that surface. Move re-arms placement;
      tapping HUD controls must not drop the assembly.
- [ ] **Camera-to-WebXR retry** — after camera fallback, use "Try real AR
      tracking". Placement starts fresh in the XR reference frame; the old
      camera reticle, preview timer, and marker tracker must not move the anchor.
- [ ] **iOS Safari** — the HUD is not hidden behind the browser toolbar, and
      Exit → Enter AR works twice in a row.
- [ ] **Sleep** — the screen stays on during a session (wake lock).

Report anything that fails with a screenshot: every fix in this repo's history
started as one, and the screenshot is usually enough to name the cause.

## Having Claude run it

- **On demand.** Ask a Claude Code session to run the battery; it will report
  numbers rather than a verdict, and can fix what it breaks.
- **On every push.** Already the case — see `.github/workflows/ci.yml`. A red
  run is a real failure; there are no known flaky checks.
- **Nightly against production.** The `production-smoke` job. Point it at a
  different deployment with a repository variable named `PREVIEW_URL`.
- **On a schedule, with triage.** A Claude *Routine* can wake a session on a
  cron, run the battery against `main` and the live site, and open a pull
  request with the fix rather than only reporting the failure. That one costs
  session time, so it is set up deliberately rather than by default.
