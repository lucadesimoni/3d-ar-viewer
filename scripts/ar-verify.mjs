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
  await page.evaluate(() => {
    setInterval(() => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 60, gamma: 0 })), 50);
  });
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
  await page.evaluate(() => {
    setInterval(() => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 60, gamma: 0 })), 50);
  });
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
  await page.evaluate(() => {
    window.__beta = 60;                                    // looking 30° down
    setInterval(() => window.dispatchEvent(new DeviceOrientationEvent(
      'deviceorientation', { alpha: 0, beta: window.__beta, gamma: 0 })), 50);
  });
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

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
