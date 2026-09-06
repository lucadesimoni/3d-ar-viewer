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

const URL = process.env.PREVIEW_URL ?? 'http://localhost:4173/';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = process.argv[2] ?? '/tmp/ar-verify';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

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
    placement: s.arPlacement, quality: s.anchorQuality,
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

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
