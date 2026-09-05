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
const SHELF_STREAM = ({ cols, rows, span }) => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 480;
  const g = c.getContext('2d');
  const boardPx = span * 0.0204;                  // 30 mm of 1470 mm
  const spanY = (span / cols) * rows;
  const left = (640 - span) / 2, top = (480 - spanY) / 2;
  const draw = () => {
    g.fillStyle = '#808080'; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#ebebeb'; g.fillRect(left, top, span, spanY);
    const pitchX = (span - boardPx) / cols, pitchY = (spanY - boardPx) / rows;
    g.fillStyle = '#2a2a2a';
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        g.fillRect(left + boardPx + cc * pitchX, top + boardPx + r * pitchY,
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
  return {
    placement: s.arPlacement, quality: s.anchorQuality,
    anchor: s.anchor ? s.anchor.position : null,
    assembly: s.assembly.id, parts: s.assembly.parts.length,
  };
});

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

  await page.click('.ar-enter');
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
  }
  await page.screenshot({ path: `${OUT}/ar-recognized.png` });
  await page.close();
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
