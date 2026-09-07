/**
 * End-to-end verification of AR anchoring, on a phone-sized viewport.
 *
 * Two things have to be true for the overlay to be worth anything, and neither
 * is provable from a unit test:
 *
 *   1. Aim-and-tap places the assembly on the estimated floor at a real
 *      distance, instead of floating it at a guessed standoff.
 *   2. Pointing the camera at the object itself anchors to it. Here the camera
 *      is a canvas stream rendering a 4x4 cube shelf, injected in place of
 *      getUserMedia, so the whole path runs for real: frame -> lattice fit ->
 *      homography -> camera-to-world -> anchor.
 *
 * Usage: node scripts/ar-verify.mjs   (with the app served on PREVIEW_URL)
 */
import { chromium } from 'playwright';
import { launchOptions, FAKE_CAMERA } from './chrome.mjs';

const URL = process.env.PREVIEW_URL ?? 'http://localhost:4173/';
const OUT = process.argv[2] ?? '/tmp/ar-verify';

const browser = await chromium.launch(launchOptions(FAKE_CAMERA));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

/** Draw a cube shelf into a canvas and serve it as the camera stream. */
const SHELF_STREAM = ({ cols, rows, span, sway = 0 }) => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 480;
  const g = c.getContext('2d');
  const boardPx = span * 0.0204;                  // 30 mm of 1470 mm
  const spanY = (span / cols) * rows;
  const left = (640 - span) / 2, top = (480 - spanY) / 2;
  const draw = () => {
    // `sway` pans the shelf across the frame, standing in for an operator
    // walking sideways — the motion the tracker has to follow between
    // detections.
    const x = left + (sway ? Math.sin(performance.now() / 900) * sway : 0);
    g.fillStyle = '#808080'; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#ebebeb'; g.fillRect(x, top, span, spanY);
    const pitchX = (span - boardPx) / cols, pitchY = (spanY - boardPx) / rows;
    g.fillStyle = '#2a2a2a';
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        g.fillRect(x + boardPx + cc * pitchX, top + boardPx + r * pitchY,
          pitchX - boardPx, pitchY - boardPx);
      }
    }
    requestAnimationFrame(draw);
  };
  draw();
  const stream = c.captureStream(12);
  navigator.mediaDevices.getUserMedia = async () => stream;
};

/**
 * A phone held the way an operator holds one: looking 30 degrees down, facing
 * some arbitrary direction, with a few degrees of roll from the hand.
 *
 * The heading matters. `alpha: 0, gamma: 0` is the one combination where a
 * swapped Euler triple still looks correct, which is how a pitch that followed
 * the compass survived every check here for as long as it did.
 */
const HELD_LOOKING_DOWN = { alpha: 217, beta: 60, gamma: 4 };

async function open(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas', { timeout: 20000 });
  await page.waitForTimeout(1500);
}
const state = (page) => page.evaluate(() => {
  const s = window.spatialStore.getState();
  const m = window.spatialScene?.();
  const canvas = document.querySelector('canvas.viewer-canvas');
  const rect = canvas?.getBoundingClientRect();
  return {
    placement: s.arPlacement, quality: s.anchorQuality, motion: s.arMotion,
    anchor: s.anchor ? s.anchor.position : null,
    rotation: s.anchor ? s.anchor.rotation : null,
    assembly: s.assembly.id, parts: s.assembly.parts.length,
    fovDeg: m ? (m.scene.activeCamera.fov * 180) / Math.PI : null,
    css: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
    buffer: canvas ? [canvas.width, canvas.height] : null,
  };
});

/** Angle between the assembly's own up axis and world up, degrees. */
function tiltDeg(q) {
  if (!q) return 999;
  const [x, y, z, w] = q;
  // Rotate (0,1,0) by q and read off its y component.
  const uy = 1 - 2 * (x * x + z * z);
  return (Math.acos(Math.max(-1, Math.min(1, uy))) * 180) / Math.PI;
}

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true, hasTouch: true,
  permissions: ['camera'],
});

// --- 1. Aim-and-tap floor placement (the iOS path). ------------------------
{
  const page = await context.newPage();
  await open(page, `${URL}?assembly=kallax-4x4`);
  const loaded = await state(page);
  check('KALLAX loads from the URL', loaded.assembly === 'kallax-4x4', `${loaded.parts} parts`);

  // The way in has to be findable on a phone. The header's button is dropped on
  // mobile precisely because a long assembly name or a wrapped badge row can
  // push it off the edge; the bottom nav carries it instead.
  const entry = page.locator('.ar-enter');
  const entryBox = await entry.boundingBox();
  const vp = page.viewportSize();
  check('the AR entry button is on screen on a phone',
    Boolean(entryBox) && entryBox.x >= 0 && entryBox.x + entryBox.width <= vp.width
      && entryBox.y + entryBox.height <= vp.height,
    entryBox ? `x=${Math.round(entryBox.x)} y=${Math.round(entryBox.y)} ${Math.round(entryBox.width)}x${Math.round(entryBox.height)}` : 'no box');
  check('and it is one button, not a hidden duplicate', await entry.count() === 1);

  await entry.click();
  await page.waitForTimeout(1500);
  const awaiting = await state(page);
  check('AR starts by asking for a surface, not by guessing',
    awaiting.placement === 'awaiting' && awaiting.anchor === null, `placement=${awaiting.placement}`);
  const hint = await page.textContent('.placement-hint').catch(() => null);
  check('the operator is told what to do', Boolean(hint && /tap/i.test(hint)), hint?.trim());

  await page.screenshot({ path: `${OUT}/ar-awaiting.png` });

  // A phone reports its attitude; without it the app cannot know where the
  // floor is and deliberately falls back to placing straight ahead (checked
  // separately below). Feed a device held upright and tilted 30 degrees down,
  // which is how someone looks at the floor a couple of metres off.
  await page.evaluate((held) => {
    setInterval(() => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', held)), 50);
  }, HELD_LOOKING_DOWN);
  await page.waitForTimeout(700);
  check('the phone attitude reaches the app', (await state(page)).motion === true);
  const hintWithMotion = await page.textContent('.placement-hint').catch(() => null);
  check('and the hint switches to the aim-and-tap wording',
    Boolean(hintWithMotion && !/no motion/i.test(hintWithMotion)), hintWithMotion?.trim());

  // Tap below the horizon: the ray must meet the ground plane.
  await page.mouse.click(195, 640);
  await page.waitForTimeout(800);
  const placed = await state(page);
  const y = placed.anchor?.[1];
  const dist = placed.anchor ? Math.hypot(placed.anchor[0], placed.anchor[2]) : 0;
  check('a tap places the assembly on the floor',
    placed.placement === 'floor' && Math.abs(y + 1.45) < 0.01,
    `y=${y?.toFixed(3)} m, ${dist.toFixed(2)} m away`);
  check('placement is at a plausible range', dist > 0.4 && dist < 12, `${dist.toFixed(2)} m`);

  // Both ends of the aim. Steeply down meets the plane directly beneath the
  // operator — a tap at the bottom of the canvas placed the assembly 40 mm from
  // the camera, inside their own face and off screen, and reported it placed.
  // Near the horizon it runs away instead. Every tap on the canvas has to give
  // something a person can look at.
  for (const [y, where] of [[680, 'at the bottom of the canvas'], [330, 'near the horizon']]) {
    await page.locator('.ar-btn', { hasText: 'Move' }).click();
    await page.waitForTimeout(700);
    await page.mouse.click(195, y);
    await page.waitForTimeout(800);
    const s = await page.evaluate(() => {
      const v = window.spatialScene().anchorViewState();
      return { d: v.distanceM, on: v.onScreen };
    });
    check(`a tap ${where} lands somewhere you can look at`,
      s.d > 0.45 && s.d < 12 && s.on, `${s.d.toFixed(2)} m, on screen ${s.on}`);
  }
  await page.screenshot({ path: `${OUT}/ar-placed.png` });
  await page.close();
}

// --- 2. Recognising the object itself. -------------------------------------
{
  const page = await context.newPage();
  await page.addInitScript(SHELF_STREAM, { cols: 4, rows: 4, span: 360 });
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.click('.ar-enter');

  let recognised = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const s = await state(page);
    if (s.placement === 'recognized') { recognised = s; break; }
  }
  check('the shelf in front of the camera is recognised and anchored',
    Boolean(recognised),
    recognised ? `quality ${(recognised.quality * 100).toFixed(0)}%, anchor ${recognised.anchor.map((v) => v.toFixed(2)).join(', ')}` : 'never locked on');
  if (recognised) {
    const range = Math.hypot(...recognised.anchor);
    check('the recognised anchor is at a sane range', range > 0.5 && range < 10, `${range.toFixed(2)} m`);
    // The bug this catches: a reflected basis out of the homography solve put
    // the shelf on its side while the position stayed plausible.
    check('the recognised assembly stands upright', tiltDeg(recognised.rotation) < 3,
      `${tiltDeg(recognised.rotation).toFixed(1)}° from vertical`);
    check('it stands on the floor, not at eye level', recognised.anchor[1] < -0.4,
      `origin ${recognised.anchor[1].toFixed(2)} m below the camera`);
  }

  // The HUD replaces the desktop chrome in AR; it has to be there and work.
  const buttons = await page.locator('.ar-bar .ar-btn').allTextContents();
  check('the AR HUD offers the full control set',
    ['Steps', 'Errors', 'View', 'Move', 'Settings', 'Exit'].every((l) => buttons.some((b) => b.includes(l))),
    buttons.join(' / '));
  const box = await page.locator('.ar-bar .ar-btn').first().boundingBox();
  check('controls are big enough for a gloved finger', box.height >= 44, `${Math.round(box.height)} px tall`);

  // iOS places a fixed element against the *layout* viewport — the tall one,
  // without Safari's toolbars — so a bar anchored to its bottom disappears
  // behind the toolbar on a real phone while every desktop viewport looks fine.
  // In the flow of a 100dvh column that cannot happen.
  const hudPosition = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.ar-hud')).position);
  check('the HUD is laid out in flow, not fixed to the viewport', hudPosition !== 'fixed', hudPosition);
  const hud = await page.locator('.ar-hud').boundingBox();
  const view = page.viewportSize();
  check('the whole HUD is inside the visible area',
    hud.y + hud.height <= view.height + 1 && hud.y >= 0,
    `bottom at ${Math.round(hud.y + hud.height)} of ${view.height}`);

  await page.locator('.ar-btn', { hasText: 'Settings' }).click();
  await page.waitForTimeout(400);
  check('settings open over the passthrough', await page.locator('.ar-settings').count() === 1);
  const sheet = await page.locator('.ar-sheet').boundingBox();
  const vh = page.viewportSize().height;
  check('the sheet leaves most of the camera visible', sheet.height < vh * 0.55,
    `${Math.round((sheet.height / vh) * 100)}% of the screen`);
  await page.screenshot({ path: `${OUT}/ar-settings.png` });
  await page.locator('.ar-btn', { hasText: 'Settings' }).click();

  await page.screenshot({ path: `${OUT}/ar-recognized.png` });
  await page.close();
}

// --- 3b. A device that claims WebXR but cannot start a session. ------------
{
  const page = await context.newPage();
  // Chrome on a phone advertises immersive-ar; the request can still be refused
  // (permission, an unsupported feature, a headset already in use). Before this
  // check the app went into "AR" anyway: a transparent canvas over a black page
  // with the model floating in the void and no camera at all.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: {
        isSessionSupported: async (mode) => mode === 'immersive-ar',
        requestSession: async () => { throw new DOMException('refused', 'NotAllowedError'); },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      },
    });
  });
  await page.addInitScript(SHELF_STREAM, { cols: 4, rows: 4, span: 360 });
  await open(page, `${URL}?assembly=kallax-4x4`);

  const advertised = await page.evaluate(() => navigator.xr.isSessionSupported('immersive-ar'));
  check('the fake device advertises WebXR', advertised);

  await page.locator('.ar-enter').click();
  await page.waitForTimeout(3000);
  const live = await page.evaluate(() => {
    const v = document.querySelector('video.passthrough');
    return { w: v?.videoWidth ?? 0, playing: Boolean(v && !v.paused), ar: window.spatialStore.getState().arPlacement };
  });
  check('a refused XR session falls back to the camera, not a black screen',
    live.w > 0 && live.playing, `video ${live.w}px, playing=${live.playing}, placement=${live.ar}`);
  await page.screenshot({ path: `${OUT}/ar-xr-fallback.png` });
  await page.close();
}

// --- 3c. Placement is a mode, not a permanent state. ----------------------
{
  const page = await context.newPage();
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.locator('.ar-enter').click();
  await page.waitForTimeout(1500);

  const placing = () => page.evaluate(() => {
    const m = window.spatialScene();
    const reticle = m?.scene.getMeshByName('ar-reticle');
    return { placing: Boolean(m?.placing), reticle: Boolean(reticle?.isEnabled()) };
  });
  const armed = await placing();
  check('placement is armed when there is nothing placed yet', armed.placing);

  await page.mouse.click(195, 640);
  await page.waitForTimeout(600);
  const after = await placing();
  check('and disarms itself once placed — the ring goes away and taps stop moving it',
    !after.placing && !after.reticle, `placing=${after.placing} reticle=${after.reticle}`);

  // "Move" is how repositioning is asked for.
  await page.locator('.ar-btn', { hasText: 'Move' }).click();
  await page.waitForTimeout(600);
  check('"Move" re-arms it on demand', (await placing()).placing);

  // With the setting off, AR opens where it was left instead of asking again.
  await page.locator('.ar-btn', { hasText: 'Exit' }).click();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const s = window.spatialStore.getState();
    s.setArSettings({ placeOnEntry: false });
    s.setAnchor({ position: [0, -1.4, 2], rotation: [0, 0, 0, 1] }, 0.6, 'floor');
  });
  await page.locator('.ar-enter').click();
  await page.waitForTimeout(1500);
  const reopened = await placing();
  const placement = await page.evaluate(() => window.spatialStore.getState().arPlacement);
  check('with "ask each time" off it opens where you left it',
    !reopened.placing && placement !== 'awaiting', `placing=${reopened.placing} placement=${placement}`);
  await page.close();
}

// --- 3d. The whole session: place, move, exit, come back. -----------------
{
  const page = await context.newPage();
  await open(page, `${URL}?assembly=kallax-4x4`);
  const camera = () => page.evaluate(() => {
    const v = document.querySelector('video.passthrough');
    const stream = v?.srcObject ?? null;
    return {
      width: v?.videoWidth ?? 0,
      held: Boolean(stream),
      live: stream ? stream.getTracks().some((t) => t.readyState === 'live') : false,
    };
  });
  const placing = () => page.evaluate(() => Boolean(window.spatialScene()?.placing));

  await page.locator('.ar-enter').click();
  await page.waitForTimeout(2500);
  check('the camera is live in AR', (await camera()).live);

  await page.mouse.click(195, 620);
  await page.waitForTimeout(600);
  check('a tap places it and disarms placement', !(await placing()));

  // In AR the overlay is a reference, not a model: a stray tap must not place a
  // part or open an inspector over the guidance.
  await page.mouse.click(195, 300);
  await page.waitForTimeout(400);
  const stray = await page.evaluate(() => {
    const s = window.spatialStore.getState();
    return {
      placed: [...s.placements.values()].filter((p) => p.status !== 'ghost').length,
      selected: s.selectedPartId ?? null,
    };
  });
  check('a stray tap in AR does not place a part or open an inspector',
    stray.placed === 0 && stray.selected === null, `placed=${stray.placed} selected=${stray.selected}`);

  await page.locator('.ar-btn', { hasText: 'Move' }).click();
  await page.waitForTimeout(700);
  check('"Move" re-arms placement in a camera session', await placing());
  await page.mouse.click(195, 640);
  await page.waitForTimeout(600);
  check('and the next tap re-places it', !(await placing()));

  await page.locator('.ar-btn', { hasText: 'Exit' }).click();
  await page.waitForTimeout(900);
  check('Exit leaves AR', await page.locator('.ar-hud').count() === 0);
  const released = await camera();
  // Stopping the tracks is not enough: an element still holding the stream is
  // what makes the next getUserMedia fail with NotReadableError on Android.
  check('Exit hands the camera back to the system', !released.held && released.width === 0,
    `held=${released.held} width=${released.width}`);

  await page.locator('.ar-enter').click();
  await page.waitForTimeout(2500);
  check('and AR can be entered again afterwards', (await camera()).live);
  await page.close();
}

// --- 3d-bis. A mis-aimed tap must not put the assembly across the street. --
{
  const page = await context.newPage();
  // The gearbox is 300 mm across. A tap near the horizon meets the estimated
  // ground plane tens of metres out, and at that range it is a few pixels of
  // nothing — the badge said "placed" and the screen showed empty floor.
  await open(page, `${URL}?assembly=bench-gearbox`);
  await page.locator('.ar-enter').click();
  await page.waitForTimeout(2000);
  const size = await page.viewportSize();
  await page.mouse.click(size.width / 2, size.height * 0.53);   // just below the horizon
  await page.waitForTimeout(700);
  const far = await page.evaluate(() => {
    const a = window.spatialStore.getState().anchor;
    return a ? Math.hypot(a.position[0], a.position[2]) : null;
  });
  check('a small assembly is never placed further away than it can be seen',
    far === null || far <= 3.2, far === null ? 'not placed' : `${far.toFixed(2)} m`);
  await page.close();
}

// --- 3e. A camera that is busy the first time, and one that stays busy. ----
{
  const page = await context.newPage();
  // `NotReadableError: Could not start video source` almost never means broken
  // hardware. It means something else holds the camera — another tab of this
  // same app, a video call — or that the device had not finished releasing it.
  // The second case clears in a fraction of a second and is worth one retry.
  await page.addInitScript(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let calls = 0;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      calls++;
      if (calls === 1) throw new DOMException('busy', 'NotReadableError');
      return real(constraints);
    };
  });
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.locator('.ar-enter').click();
  await page.waitForTimeout(3500);
  const recovered = await page.evaluate(() => {
    const v = document.querySelector('video.passthrough');
    return { width: v?.videoWidth ?? 0, error: window.spatialStore.getState().arError ?? null };
  });
  check('a camera that is busy for a moment is retried, not given up on',
    recovered.width > 0 && !recovered.error, `width=${recovered.width} error=${recovered.error}`);
  await page.close();
}
{
  const page = await context.newPage();
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('busy', 'NotReadableError');
    };
  });
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.locator('.ar-enter').click();
  await page.waitForTimeout(4000);
  const message = await page.textContent('.ar-error').catch(() => null);
  check('a camera that stays busy is explained, not left silent',
    Boolean(message && /busy|another tab/i.test(message)), message?.replace(/\s+/g, ' ').trim());
  await page.close();
}

// --- 4. Following a moving object between detections. ---------------------
{
  const page = await context.newPage();
  await page.addInitScript(SHELF_STREAM, { cols: 4, rows: 4, span: 340, sway: 55 });
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.click('.ar-enter');

  let locked = false;
  for (let i = 0; i < 20 && !locked; i++) {
    await page.waitForTimeout(400);
    locked = (await state(page)).placement === 'recognized';
  }
  check('locks onto a moving shelf', locked);

  // Record every anchor change for two seconds while the shelf pans.
  const log = await page.evaluate(async () => {
    const seen = [];
    let previous = null;
    const stop = window.spatialStore.subscribe((s) => {
      if (!s.anchor) return;
      const p = s.anchor.position;
      if (previous && Math.hypot(p[0] - previous[0], p[1] - previous[1], p[2] - previous[2]) < 0.001) return;
      previous = p;
      seen.push([performance.now(), p[0]]);
    });
    await new Promise((r) => setTimeout(r, 2000));
    stop();
    return seen;
  });

  // Detection alone runs at the perf profile's interval (0.4-1 s), so anything
  // above ~5 updates in two seconds can only come from frame-by-frame tracking.
  check('the anchor follows the object between detections', log.length >= 12,
    `${log.length} anchor updates in 2 s`);
  const xs = log.map((e) => e[1]);
  const swing = Math.max(...xs) - Math.min(...xs);
  check('and it actually moves with it', swing > 0.15, `${swing.toFixed(2)} m of travel tracked`);
  // Consecutive updates must be small: a tracker that keeps re-detecting from
  // scratch jumps, a tracker that follows glides.
  const jumps = xs.slice(1).map((v, i) => Math.abs(v - xs[i]));
  const worst = Math.max(...jumps);
  check('the overlay glides rather than jumping', worst < 0.2, `largest step ${worst.toFixed(3)} m`);
  await page.close();
}

// --- 5. Tablet in landscape: the case the desktop layout used to ruin. ------
{
  const tablet = await browser.newContext({
    viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, permissions: ['camera'],
  });
  const page = await tablet.newPage();
  await page.addInitScript(SHELF_STREAM, { cols: 4, rows: 4, span: 360 });
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.click('.ar-enter');
  await page.waitForTimeout(3000);

  const s = await state(page);
  const cssAspect = s.css[0] / s.css[1];
  const bufAspect = s.buffer[0] / s.buffer[1];
  check('the render buffer matches the canvas shape',
    Math.abs(cssAspect - bufAspect) / cssAspect < 0.02,
    `css ${s.css.join('x')} vs buffer ${s.buffer.join('x')}`);
  // A 4:3 camera frame in a landscape viewport is cropped top and bottom, so
  // the visible vertical FOV is narrower than the camera's own 60 degrees.
  check('the overlay uses the field of view actually on screen', s.fovDeg < 58,
    `${s.fovDeg.toFixed(1)}° effective`);
  check('no side panels steal the camera view on a tablet',
    await page.locator('.stage > .step-guide').count() === 0);
  await page.screenshot({ path: `${OUT}/ar-tablet-landscape.png` });
  await page.close();
  await tablet.close();
}

// --- 3. A frame with no shelf must not anchor to anything. -----------------
{
  const page = await context.newPage();
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.click('.ar-enter');
  await page.waitForTimeout(4000);
  const s = await state(page);
  check('random camera noise never claims a recognition', s.placement !== 'recognized', `placement=${s.placement}`);
  await page.close();
}

// --- 6. HUD chrome: nothing may cover the control bar. ---------------------
// The verdict banner used to be pinned to the bottom of the viewport, which in
// AR is the *screen* bottom — it landed behind the step buttons and hid them,
// and its nowrap text ran past both edges of a 390 px phone.
{
  const page = await context.newPage();
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.click('.ar-enter');
  await page.waitForTimeout(2500);
  // Force the longest verdict there is, so overflow shows up if it can.
  await page.evaluate(() => {
    const s = window.spatialStore.getState();
    const parts = s.assembly.parts;
    s.setRecognition({
      objects: [], verdict: 'wrong', expectedLabels: parts.slice(0, 3).map((p) => p.id),
      wrongLabel: parts[parts.length - 1].id, wrongName: parts[parts.length - 1].name,
      ts: Date.now(),
    });
  });
  await page.waitForTimeout(400);

  const hud = await page.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
    // Anything full-bleed (the camera image, the 3D canvas) is *under* the bar
    // by design, so an intersecting rectangle proves nothing. What matters is
    // what the finger actually hits: sample a grid over the bar and require the
    // topmost element at every point to belong to the bar.
    const bar = r('.ar-bar');
    const barEl = document.querySelector('.ar-bar');
    const overlapping = new Set();
    if (bar) {
      for (let iy = 1; iy < 8; iy++) {
        for (let ix = 1; ix < 20; ix++) {
          const top = document.elementFromPoint(
            bar.left + (bar.width * ix) / 20, bar.top + (bar.height * iy) / 8);
          if (top && !barEl.contains(top) && top !== barEl) {
            overlapping.add(`${top.className || top.tagName}`);
          }
        }
      }
    }
    // Every control must be the topmost element at its own centre.
    const unreachable = [];
    for (const b of document.querySelectorAll('.ar-bar .ar-btn')) {
      const q = b.getBoundingClientRect();
      const top = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
      if (!top || !(b.contains(top) || top === b)) unreachable.push(b.textContent.trim());
    }
    // Long verdicts are the ones that used to run off both edges. React may
    // re-render over this within a frame, so write and measure in one go.
    const banner = r('.recognition-banner');
    let longest = null;
    const text = document.querySelector('.recognition-banner .reco-text');
    if (text) {
      text.textContent = 'Wrong part: Left side panel, pre-drilled — expected Bottom board, Top board, Back panel';
      const b = document.querySelector('.recognition-banner').getBoundingClientRect();
      longest = [Math.round(b.left), Math.round(b.right)];
    }
    return {
      longest,
      overlapping: [...overlapping], unreachable, banner: banner && [Math.round(banner.left), Math.round(banner.right)],
      bannerInHud: !!document.querySelector('.ar-hud .recognition-banner'),
      width: innerWidth, docWidth: document.documentElement.scrollWidth,
    };
  });

  check('the verdict banner is docked in the HUD, not floating over it', hud.bannerInHud);
  // On-object labels cannot be docked — their position is their meaning — so
  // they are dropped when they would fall behind the HUD. Half a label poking
  // out from under the control bar reads as a rendering fault.
  const buried = await page.evaluate(() => {
    const hudEl = document.querySelector('.ar-hud');
    if (!hudEl) return [];
    const top = hudEl.getBoundingClientRect().top;
    return [...document.querySelectorAll('.step-tag, .reco-pin')]
      .filter((el) => el.getBoundingClientRect().bottom > top)
      .map((el) => el.textContent.trim());
  });
  check('no on-object label is left stranded behind the HUD', buried.length === 0,
    buried.join(', '));
  check('nothing covers the AR control bar', hud.overlapping.length === 0, hud.overlapping.join(', '));
  check('every AR button is the topmost element at its centre', hud.unreachable.length === 0, hud.unreachable.join(', '));
  check('the banner stays inside the viewport',
    !hud.banner || (hud.banner[0] >= 0 && hud.banner[1] <= hud.width),
    hud.banner ? `x ${hud.banner[0]}..${hud.banner[1]} of ${hud.width}` : 'no banner');
  check('even the longest verdict is clipped, not spilled',
    !hud.longest || (hud.longest[0] >= 0 && hud.longest[1] <= hud.width),
    hud.longest ? `x ${hud.longest[0]}..${hud.longest[1]} of ${hud.width}` : 'no banner');
  check('the page never scrolls sideways', hud.docWidth <= hud.width, `${hud.docWidth} vs ${hud.width} px`);
  await page.screenshot({ path: `${OUT}/ar-hud-banner.png` });
  await page.close();
}

// --- 7. No motion sensor: place straight ahead rather than guess a floor. --
// A tablet or a locked-down browser reports no attitude. The old build still
// drew a reticle and intersected a level camera with the floor plane, which put
// the assembly tens of metres away — "placed 60%, nothing visible". With no
// attitude the honest answer is to put it at arm's length in front.
{
  const page = await context.newPage();
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.click('.ar-enter');
  await page.waitForTimeout(1500);
  const before = await state(page);
  check('a phone with no attitude reports no motion', before.motion === false);
  const reticle = await page.evaluate(() => {
    const m = window.spatialScene?.().scene.getMeshByName('ar-reticle');
    return Boolean(m && m.isEnabled());
  });
  check('and no floor reticle is drawn that it cannot honour', reticle === false);

  await page.mouse.click(195, 500);
  await page.waitForTimeout(800);
  const after = await state(page);
  const dist = after.anchor ? Math.hypot(...after.anchor) : 0;
  check('a tap still places the assembly', Boolean(after.anchor), `placement=${after.placement}`);
  check('straight ahead, at a range it can actually be seen at', dist > 0.4 && dist < 6,
    `${dist.toFixed(2)} m away`);
  await page.close();
}

// --- 8. Choosing the surface, and not claiming to recognise what it cannot. -
// "Looking for Base plate…" ran forever on the live build: no detector model is
// deployed, so the pipeline returned nothing and the banner reported that as an
// eternal search. And the tap always landed on the floor, so a bench assembly
// sank through the bench.
{
  const page = await context.newPage();
  await open(page, `${URL}?assembly=kallax-4x4`);
  await page.click('.ar-enter');
  await page.evaluate((held) => {
    setInterval(() => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', held)), 50);
  }, HELD_LOOKING_DOWN);
  await page.waitForTimeout(2500);

  check('no part-recognition claim without a model',
    await page.locator('.recognition-banner').count() === 0,
    await page.locator('.recognition-banner').first().textContent().catch(() => ''));

  await page.mouse.click(195, 640);
  await page.waitForTimeout(600);
  const onFloor = (await state(page)).anchor;
  const hint = await page.textContent('.placement-hint');
  check('a hand-made placement is not reported as a percentage',
    !/%/.test(hint) && /move/i.test(hint), hint.trim());

  // Switch to a table and re-place at the same screen point.
  await page.click('.ar-btn:has-text("Settings")');
  await page.click('.ar-chip:has-text("Table")');
  await page.click('.ar-btn:has-text("Settings")');
  await page.click('.ar-btn:has-text("Move")');
  await page.waitForTimeout(500);
  const aimingAt = await page.textContent('.placement-hint');
  check('the hint names the surface being aimed at', /table/i.test(aimingAt), aimingAt.trim());
  await page.mouse.click(195, 640);
  await page.waitForTimeout(600);
  const onTable = (await state(page)).anchor;

  const rise = onTable[1] - onFloor[1];
  check('placing on a table lands a table-height above the floor',
    Math.abs(rise - 0.75) < 0.02, `${rise.toFixed(3)} m higher`);
  // Same plane, same aim: it must land nearer, not just higher.
  const near = Math.hypot(onTable[0], onTable[2]) < Math.hypot(onFloor[0], onFloor[2]);
  check('and nearer, because the ray meets the higher plane sooner', near,
    `${Math.hypot(onTable[0], onTable[2]).toFixed(2)} m vs ${Math.hypot(onFloor[0], onFloor[2]).toFixed(2)} m`);
  await page.screenshot({ path: `${OUT}/ar-surface-table.png` });
  await page.close();
}

// --- 9. Anchored, but nowhere to be seen. ---------------------------------
// The report this exists for: "camera works but I don't see the objects
// anywhere". Nothing is broken — you aim at the floor, tap, then raise the
// phone to look forward, and a small assembly anchored 1.45 m below eye level
// is far under the bottom edge of a 60-degree view. The app used to say
// "Placed" and show an empty screen, which is indistinguishable from a bug.
{
  const page = await context.newPage();
  await open(page, URL);
  await page.click('.ar-enter');
  await page.evaluate((held) => {
    window.__beta = held.beta;                             // looking 30° down
    setInterval(() => window.dispatchEvent(new DeviceOrientationEvent(
      'deviceorientation', { ...held, beta: window.__beta })), 50);
  }, HELD_LOOKING_DOWN);
  await page.waitForTimeout(1200);
  await page.mouse.click(195, 640);
  await page.waitForTimeout(600);

  const view = () => page.evaluate(() => window.spatialScene().anchorViewState());
  const placed = await view();
  check('what was just placed is in view', placed.onScreen,
    `x=${placed.x.toFixed(2)} y=${placed.y.toFixed(2)} at ${placed.distanceM.toFixed(2)} m`);
  check('and nothing nags while it is', await page.locator('.offscreen-nudge').count() === 0);

  // Raise the phone to look above the horizon, as anyone does after placing.
  await page.evaluate(() => { window.__beta = 105; });
  await page.waitForTimeout(800);
  const lost = await view();
  check('looking away takes it off screen — the real complaint', !lost.onScreen,
    `${lost.direction}, ${lost.offScreenDeg.toFixed(0)}° outside the frame`);
  const nudge = await page.textContent('.offscreen-nudge').catch(() => null);
  check('and the operator is told where it went, not left guessing',
    Boolean(nudge && /look down/i.test(nudge)), nudge?.replace(/\s+/g, ' ').trim());

  await page.click('.offscreen-act');
  await page.waitForTimeout(500);
  const back = await view();
  check('"Bring it here" puts it in the middle of the view', back.onScreen
    && Math.abs(back.x - 0.5) < 0.15 && Math.abs(back.y - 0.5) < 0.2,
    `x=${back.x.toFixed(2)} y=${back.y.toFixed(2)} at ${back.distanceM.toFixed(2)} m`);
  check('at a distance a small assembly can be made out at', back.distanceM < 2.5,
    `${back.distanceM.toFixed(2)} m`);
  check('and the nudge goes away once it is back', await page.locator('.offscreen-nudge').count() === 0);
  await page.screenshot({ path: `${OUT}/ar-brought-back.png` });
  await page.close();
}

// --- 10. Pixels, not projections. -----------------------------------------
// Every "is it in view" check so far is a projection: maths about where the
// assembly *would* land. None of them prove a single pixel was drawn over the
// camera. This one reads the canvas back.
{
  const page = await context.newPage();
  await open(page, URL);
  await page.click('.ar-enter');
  await page.evaluate((held) => {
    setInterval(() => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', held)), 50);
  }, HELD_LOOKING_DOWN);
  await page.waitForTimeout(1200);

  // How much of the view the overlay actually painted.
  //
  // Read from *inside* the frame, via the app's own sampler. Reading the canvas
  // from outside — after the browser has composited it — needs
  // `preserveDrawingBuffer`, which is a trap on mobile GPUs and is no longer
  // set; without it such a read quietly returns a buffer of zeros. That is the
  // worst possible failure for an instrument: "0.0% painted" is exactly the
  // conclusion someone acts on, and it can be a lie. Arm, then collect.
  const painted = async () => {
    await page.evaluate(() => window.spatialScene().paintedFraction());
    await page.waitForTimeout(350);
    return page.evaluate(() => window.spatialScene().paintedFraction());
  };

  // Entering AR used to put the operator *inside* the assembly: unanchored, it
  // sits at the world origin, which is the head. Half the screen was the
  // translucent insides of a gearbox.
  const beforePlacing = await painted();
  check('AR opens on the real world, not inside the model', beforePlacing < 0.02,
    `${(beforePlacing * 100).toFixed(1)}% drawn before anything is placed`);
  await page.mouse.click(195, 640);
  await page.waitForTimeout(900);

  const stats = await page.evaluate(() => window.spatialScene().renderStats());
  check('the renderer is the one the checks actually cover', stats.backend === 'webgl',
    stats.backend);
  check('part meshes exist and are being drawn', stats.partMeshes > 0 && stats.activeMeshes > 0,
    `${stats.activeMeshes} active of ${stats.meshes}, ${stats.partMeshes} parts`);
  check('the render buffer is not empty', stats.bufferSize[0] > 0 && stats.bufferSize[1] > 0,
    `${stats.cssSize.join('x')} css → ${stats.bufferSize.join('x')} buffer`);


  const coverage = await painted();
  // Not "is it drawn" but "can it be seen". A bench gearbox placed on the floor
  // is 1.9 m from a standing operator and covers 1.7% of a phone screen — a
  // grey smudge behind its own label, which is exactly what "I still don't see
  // anything" was. The assembly says where it is built; on its bench the same
  // tap lands at 0.75 m and covers 10%.
  check('the assembly is big enough on screen to work from', coverage > 0.04,
    `${(coverage * 100).toFixed(1)}% of the screen`);
  const surface = await page.evaluate(() =>
    window.spatialStore.getState().arSettings.surfaceHeightM);
  check('and it defaults to the surface the job is done on', surface > 0.5,
    `${surface} m above the floor`);
  const outlined = await page.evaluate(() => {
    const m = window.spatialScene();
    const step = window.spatialStore.getState().assembly.steps[0];
    return step.partIds.every((id) => m.scene.getMeshByName(`mesh-${id}`)?.renderOutline);
  });
  check('the active step is outlined, so it reads against a real room', outlined);

  // The check that matters, and the one this suite lacked: with the parts
  // hidden, the camera image must be untouched. The studio set — bench,
  // fixture plate, ground grid — used to be drawn over the real world at 25%
  // alpha and covered 98% of the screen; the gearbox was 1.7% of the pixels,
  // underneath it. Nothing looked broken in a screenshot, and nothing was
  // visible on a phone.
  // The contact shadow and footprint go with the parts: they are how the
  // assembly says it is resting on something, not studio scenery.
  await page.evaluate(() => {
    window.__hidden = window.spatialScene().scene.meshes
      .filter((x) => x.name.startsWith('mesh-') || x.name.startsWith('ar-ground-'));
    window.__hidden.forEach((x) => x.setEnabled(false));
  });
  await page.waitForTimeout(400);
  const scenery = await painted();
  check('nothing but the assembly paints over the camera', scenery < 0.02,
    `${(scenery * 100).toFixed(1)}% of the camera covered by scenery`);
  await page.evaluate(() => window.__hidden.forEach((x) => x.setEnabled(true)));
  await page.waitForTimeout(400);

  // The app has to be able to answer this question about itself: the readout in
  // the settings sheet is the only number that proves a pixel reached the
  // screen, and it is what a report of "I see nothing" now turns into.
  // The measurement has to be stable, or a phone reading it once gets noise.
  const second = await painted();
  check('the measurement is stable between frames', Math.abs(second - coverage) < 0.02,
    `${(coverage * 100).toFixed(1)}% then ${(second * 100).toFixed(1)}%`);

  // A blank overlay has three causes that look identical from outside: a dead
  // render loop, a lost graphics context, and a frame that throws every time.
  // All three are reported, so a phone can say which one it is.
  const health = await page.evaluate(async () => {
    const m = window.spatialScene();
    const before = m.renderStats().frames;
    await new Promise((r) => setTimeout(r, 500));
    const s = m.renderStats();
    return { advanced: s.frames - before, contextLost: s.contextLost, err: s.renderError, camera: s.camera };
  });
  check('the render loop is alive and says so', health.advanced > 0,
    `${health.advanced} frames in 500 ms`);

  // A render loop is a requestAnimationFrame chain, and a chain ends the moment
  // one link fails to schedule the next — a frozen tab, a lost context, an
  // engine that gave up. What is left is a permanently transparent canvas and
  // an app with no idea. Kill it the way a browser would and require recovery.
  await page.evaluate(() => window.spatialScene().engine.stopRenderLoop());
  await page.waitForTimeout(1200);
  const down = await page.evaluate(() => {
    const m = window.spatialScene();
    m.renderStats();
    return new Promise((r) => setTimeout(() => r(m.renderStats()), 400));
  });
  check('a stopped loop is noticed, not silently endured', down.fps < 1,
    `${Math.round(down.fps)} fps after stopping`);
  const fault = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.ar-btn')].find((b) => b.textContent.includes('Settings'));
    btn.click();
    return new Promise((r) => setTimeout(() => r(document.querySelector('.ar-diagnosis')?.textContent ?? null), 700));
  });
  check('and it is reported in words, not left to be inferred',
    Boolean(fault && /render loop has stopped/i.test(fault)), fault?.slice(0, 60));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.ar-btn')].find((b) => b.textContent.includes('Settings'));
    btn.click();
  });
  await page.waitForTimeout(5000);                      // two watchdog beats
  const back = await page.evaluate(() => {
    const m = window.spatialScene();
    m.renderStats();
    return new Promise((r) => setTimeout(() => r(m.renderStats()), 400));
  });
  check('and the watchdog brings it back on its own', back.fps > 1 && back.stalls > 0,
    `${Math.round(back.fps)} fps after ${back.stalls} restart(s)`);

  // The harder case, and the one a phone actually reported: requestAnimationFrame
  // accepts callbacks and never calls them again. Re-arming that loop achieves
  // nothing however many times you try — a device logged 13436 restarts and
  // never drew another frame. The clock has to change, not the loop.
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await page.waitForTimeout(6000);
  const onTimer = await page.evaluate(() => {
    const m = window.spatialScene();
    m.renderStats();
    return new Promise((r) => setTimeout(() => r(m.renderStats()), 500));
  });
  check('a dead animation clock is abandoned for one that still ticks',
    onTimer.clock === 'timer' && onTimer.fps > 1,
    `${Math.round(onTimer.fps)} fps on the ${onTimer.clock} clock`);
  const timerPaint = await painted();
  check('and the overlay paints on it', timerPaint > 0.04,
    `${(timerPaint * 100).toFixed(1)}% of the screen`);
  // One watchdog, armed once. Arming another on every restart is how thousands
  // of timers ended up on the main thread starving the frames they were meant
  // to rescue.
  const growth = await page.evaluate(() => {
    const m = window.spatialScene();
    const before = m.renderStats().stalls;
    return new Promise((r) => setTimeout(() => r(m.renderStats().stalls - before), 5000));
  });
  check('and the rescue does not multiply itself', growth <= 1, `${growth} extra restarts in 5 s`);
  check('no frame is failing silently', !health.err, health.err);
  check('the graphics context is held', !health.contextLost);
  check('an AR camera is the one rendering', health.camera === 'arcam', health.camera);

  // The marker is the diagnostic offered to the operator; it has to work, and
  // it has to be *looked at* — switching it on from the sheet used to leave the
  // sheet covering the middle of the view, where the marker is.
  const markerBox = () => page.locator('.ar-toggle', { hasText: 'test marker' }).locator('input');
  await page.locator('.ar-btn', { hasText: 'Settings' }).click();
  await page.waitForTimeout(600);
  await markerBox().click();
  await page.waitForTimeout(700);
  // A switch that does not stay switched reads as a switch that cannot be
  // operated: the state lives in the scene, not in a component that is
  // unmounted every time the sheet closes.
  check('the marker switch stays on when tapped', await markerBox().isChecked());
  check('and the sheet stays put, so the tap is not a disappearing act',
    await page.locator('.ar-sheet').count() === 1);
  // Measured with the sheet still open, which is the situation the operator is
  // actually in when they tick the box: the marker has to add visible pixels
  // *there*, not only once the sheet is dismissed.
  const withMarker = await painted();
  check('and it paints, above the sheet, one metre ahead whatever else is wrong',
    withMarker > coverage + 0.03, `${(withMarker * 100).toFixed(1)}% of pixels drawn`);

  // Close and reopen: it has to remember.
  await page.locator('.ar-btn', { hasText: 'Settings' }).click();
  await page.waitForTimeout(400);
  await page.locator('.ar-btn', { hasText: 'Settings' }).click();
  await page.waitForTimeout(600);
  check('and it remembers across closing the sheet', await markerBox().isChecked());
  await markerBox().click();
  await page.waitForTimeout(400);
  check('and switches off again',
    !(await markerBox().isChecked()) && !(await page.evaluate(() => window.spatialScene().hasTestMarker())));
  await page.locator('.ar-btn', { hasText: 'Settings' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/ar-painted.png` });
  await page.close();
}

// --- 11. Repositioning must not walk away. ---------------------------------
// Reported from a laptop: "every time I reposition, it gets smaller". It did —
// 0.5 m, then 1.0, 1.8, 3.0, 4.7, and 4% of the screen down to nothing. The
// standoff is derived from the assembly's measured radius, and the measurement
// unioned the old position with the new one, because `minimumWorld` is cached
// from the last time a mesh was transformed and a disabled mesh is never
// transformed. Every placement therefore made the assembly measure bigger,
// which pushed the next one further away.
{
  // A laptop: no touch, no attitude, a webcam.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().grantPermissions(['camera']);
  await open(page, URL);
  await page.click('.ar-enter');
  await page.waitForTimeout(2500);

  const place = async () => {
    await page.mouse.click(720, 620);
    await page.waitForTimeout(900);
    await page.evaluate(() => window.spatialScene().paintedFraction());
    await page.waitForTimeout(350);
    return page.evaluate(() => {
      const m = window.spatialScene();
      return {
        dist: m.anchorViewState().distanceM,
        radius: m.assemblyRadiusM(),
        painted: m.paintedFraction() ?? 0,
      };
    });
  };

  const first = await place();
  let last = first;
  for (let i = 0; i < 4; i++) {
    await page.locator('.ar-btn', { hasText: 'Move' }).click();
    await page.waitForTimeout(700);
    last = await place();
  }
  check('the assembly does not grow as it is measured',
    Math.abs(last.radius - first.radius) < 0.01,
    `${first.radius.toFixed(2)} m then ${last.radius.toFixed(2)} m`);
  check('and repositioning puts it back at the same distance',
    Math.abs(last.dist - first.dist) < 0.05,
    `${first.dist.toFixed(2)} m then ${last.dist.toFixed(2)} m`);
  check('so it is still the same size on screen after five placements',
    last.painted > 0.02 && Math.abs(last.painted - first.painted) < 0.01,
    `${(first.painted * 100).toFixed(1)}% then ${(last.painted * 100).toFixed(1)}%`);
  await page.close();
}

// --- 12. The world has to stay put when the phone moves. -------------------
// The property that makes an overlay AR rather than a sticker: turn the phone
// and the anchored assembly stays where it is in the room, so it slides the
// *other* way across the screen. It did the opposite — "on phone it moves in
// completely contrary directions" — because the device orientation reached
// Babylon without a handedness conversion. The look direction was right, so
// nothing looked obviously broken until you turned.
{
  const page = await context.newPage();
  await open(page, URL);
  await page.click('.ar-enter');
  await page.evaluate((held) => {
    window.__o = { ...held };
    setInterval(() => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', window.__o)), 40);
  }, HELD_LOOKING_DOWN);
  await page.waitForTimeout(1500);
  await page.mouse.click(195, 640);
  await page.waitForTimeout(900);

  const where = () => page.evaluate(() => {
    const v = window.spatialScene().anchorViewState();
    return { x: v.x, y: v.y };
  });
  const turn = async (patch) => {
    await page.evaluate((o) => { window.__o = { ...window.__o, ...o }; }, patch);
    await page.waitForTimeout(600);
    return where();
  };

  const base = await where();
  const alpha = HELD_LOOKING_DOWN.alpha;
  // W3C alpha increases as the device turns anticlockwise seen from above —
  // the operator turning to their left.
  const left = await turn({ alpha: alpha + 30 });
  check('turning left slides the assembly right, not left', left.x > base.x + 0.05,
    `x ${base.x.toFixed(2)} -> ${left.x.toFixed(2)}`);
  const right = await turn({ alpha: alpha - 30 });
  check('and turning right slides it left', right.x < base.x - 0.05,
    `x ${base.x.toFixed(2)} -> ${right.x.toFixed(2)}`);

  await turn({ alpha });
  const up = await turn({ beta: HELD_LOOKING_DOWN.beta + 15 });
  check('tilting the phone up slides it down', up.y > base.y + 0.03,
    `y ${base.y.toFixed(2)} -> ${up.y.toFixed(2)}`);
  const down = await turn({ beta: HELD_LOOKING_DOWN.beta - 15 });
  check('and tilting it down slides it up', down.y < base.y - 0.03,
    `y ${base.y.toFixed(2)} -> ${down.y.toFixed(2)}`);

  // Turn away and back: an anchor that drifts is as bad as one that inverts.
  // The filter deliberately takes the last fraction of a degree slowly — that
  // is what holds the overlay still in the hand — so this waits for it to
  // settle. How *fast* it follows is a separate property, checked below.
  await turn({ beta: HELD_LOOKING_DOWN.beta });
  await turn({ alpha: alpha + 90 });
  await turn({ alpha });
  await page.waitForTimeout(1500);
  const home = await where();
  check('and coming back leaves it exactly where it was',
    Math.abs(home.x - base.x) < 0.02 && Math.abs(home.y - base.y) < 0.02,
    `${base.x.toFixed(2)},${base.y.toFixed(2)} -> ${home.x.toFixed(2)},${home.y.toFixed(2)}`);
  await page.close();
}

// --- 13. Held still, it has to sit still. ----------------------------------
// "Now it is very unstable, hops around." A phone's magnetometer indoors sits
// quiet and then jumps ten or twenty degrees as it passes something steel.
// Followed faithfully, that moved the overlay a quarter of the screen while the
// operator held the phone motionless.
{
  const page = await context.newPage();
  await open(page, URL);
  await page.click('.ar-enter');
  await page.evaluate(() => {
    window.__alpha = 217;
    window.__glitch = 0.06;
    const n = () => (Math.random() - 0.5) * 0.6;              // ±0.3° of noise
    setInterval(() => {
      const g = Math.random() < window.__glitch ? (Math.random() - 0.5) * 40 : 0;
      const base = { alpha: window.__alpha + n() + g, beta: 60 + n(), gamma: 4 + n() };
      // Android fires both names, and their references disagree.
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { ...base, alpha: base.alpha - 12 }));
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { ...base, absolute: true }));
    }, 30);
  });
  await page.waitForTimeout(1800);
  await page.mouse.click(195, 640);
  await page.waitForTimeout(1000);

  const spread = async () => {
    const xs = [];
    for (let i = 0; i < 30; i++) {
      xs.push(await page.evaluate(() => window.spatialScene().anchorViewState().x));
      await page.waitForTimeout(45);
    }
    return Math.max(...xs) - Math.min(...xs);
  };
  const still = await spread();
  check('a phone held still holds the overlay still', still < 0.03,
    `${(still * 100).toFixed(2)}% of the width, peak to peak`);

  // …without becoming unresponsive, which is the easy way to pass the above.
  await page.evaluate(() => { window.__glitch = 0; });
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => window.spatialScene().anchorViewState().x);
  const started = Date.now();
  await page.evaluate(() => { window.__alpha += 25; });
  let moved = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(50);
    const x = await page.evaluate(() => window.spatialScene().anchorViewState().x);
    if (Math.abs(x - before) > 0.4) { moved = Date.now() - started; break; }
  }
  check('and a real turn is still followed promptly', moved > 0 && moved < 600,
    moved ? `${moved} ms` : 'never followed');
  await page.close();
}

// --- 14. Standing on something, visibly. -----------------------------------
// A virtual object over a camera image has no shadow and no occlusion, so it
// reads as floating however correctly it is anchored: nothing on screen says
// which of the surfaces behind it the thing is meant to be resting on. A
// contact shadow and the footprint's outline are what a photograph would have
// given for free.
{
  const page = await context.newPage();
  await open(page, URL);

  const marks = () => page.evaluate(() => {
    const m = window.spatialScene();
    const shadow = m.scene.getMeshByName('ar-ground-shadow');
    const outline = m.scene.getMeshByName('ar-ground-outline');
    const parts = m.scene.meshes.filter((x) => x.name.startsWith('mesh-'));
    let bottom = Infinity;
    for (const x of parts) { x.computeWorldMatrix(true); bottom = Math.min(bottom, x.getBoundingInfo().boundingBox.minimumWorld.y); }
    return {
      shadowOn: Boolean(shadow?.isEnabled()),
      outlineOn: Boolean(outline?.isEnabled()),
      // Parented to the assembly, so its rotation carries them.
      parented: shadow?.parent?.name === 'assembly' && outline?.parent?.name === 'assembly',
      shadowWorldY: shadow ? shadow.getAbsolutePosition().y : null,
      bottom: Number.isFinite(bottom) ? bottom : null,
      scaling: shadow ? [shadow.scaling.x, shadow.scaling.z] : null,
    };
  });

  check('the studio view is not given a fake shadow', !(await marks()).shadowOn);

  await page.click('.ar-enter');
  await page.evaluate((held) => {
    setInterval(() => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', held)), 40);
  }, HELD_LOOKING_DOWN);
  await page.waitForTimeout(1800);
  check('and nothing is drawn on the floor before anything is placed',
    !(await marks()).shadowOn);

  await page.mouse.click(195, 640);
  await page.waitForTimeout(1200);
  const placed = await marks();
  check('a placed assembly casts a contact shadow', placed.shadowOn && placed.outlineOn);
  // At the bottom of the assembly, not at the placement plane: where it
  // actually rests is the honest answer, and the two differ as parts move.
  check('the shadow sits under the assembly, not at a guessed plane',
    Math.abs(placed.shadowWorldY - placed.bottom) < 0.01,
    `shadow at ${placed.shadowWorldY.toFixed(3)}, assembly bottom ${placed.bottom.toFixed(3)}`);
  // Parented, so a rotated assembly gets a rotated footprint rather than the
  // world-axis-aligned diamond a world-space box produces.
  check('and it turns with the assembly instead of lying across it', placed.parented);

  await page.locator('.ar-btn', { hasText: 'Exit' }).click();
  await page.waitForTimeout(1200);
  check('and it goes when AR does', !(await marks()).shadowOn);
  await page.close();
}

// --- 15. The aiming marker must not appear to spin. ------------------------
// "Der optische Platzierkreis dreht sich beim Bewegen." Its rotation was
// identity the whole time — what changes is the ellipse a flat circle projects
// to as the heading changes, which reads as spinning. A tick kept facing the
// operator gives the marker a fixed aspect, and shows which way the assembly
// will be turned when it lands there.
{
  const page = await context.newPage();
  await open(page, URL);
  await page.click('.ar-enter');
  await page.evaluate((held) => {
    window.__o = { ...held };
    setInterval(() => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', window.__o)), 40);
  }, HELD_LOOKING_DOWN);
  await page.waitForTimeout(1800);

  const facing = () => page.evaluate(() => {
    const m = window.spatialScene();
    const r = m.scene.getMeshByName('ar-reticle');
    if (!r || !r.isEnabled()) return null;
    const cam = m.scene.activeCamera;
    const fwd = r.getDirection(new (Object.getPrototypeOf(cam.position).constructor)(0, 0, 1));
    const toCam = cam.position.subtract(r.getAbsolutePosition());
    fwd.y = 0; toCam.y = 0;
    fwd.normalize(); toCam.normalize();
    return (Math.acos(Math.max(-1, Math.min(1, fwd.x * toCam.x + fwd.z * toCam.z))) * 180) / Math.PI;
  });

  check('the aiming marker is drawn while placement is armed', (await facing()) !== null);
  const off = [];
  for (const d of [0, 40, 90, 160, 250]) {
    await page.evaluate((a) => { window.__o = { ...window.__o, alpha: a }; }, HELD_LOOKING_DOWN.alpha + d);
    await page.waitForTimeout(600);
    off.push(await facing());
  }
  const worst = Math.max(...off.filter((v) => v !== null));
  check('and keeps the same face towards the operator at every heading',
    worst < 5, `worst ${worst.toFixed(1)}° off`);
  await page.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
