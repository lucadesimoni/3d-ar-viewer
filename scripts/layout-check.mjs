/**
 * The start screen, before any AR: is the model actually visible, and does the
 * chrome leave room for it?
 *
 * The fault this exists for: `frameCamera` measured the assembly *with its
 * bench and wall*, so a 0.26 m gearbox was framed as a 0.72 m object. On a
 * phone it came out 11% of the screen wide and 4% tall — a speck in the middle
 * of an empty grid, on the one screen whose whole job is to show the model.
 * Nothing failed; it just looked like an empty app.
 *
 * Usage: node scripts/layout-check.mjs   (with the app served on PREVIEW_URL)
 */
import { chromium } from 'playwright';
import { launchOptions, FAKE_CAMERA } from './chrome.mjs';

const URL = process.env.PREVIEW_URL ?? 'http://localhost:4173/';
const OUT = process.argv[2] ?? '/tmp/layout-check';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch(launchOptions());

/** Viewports that have to work, and what each one is the hard case for. */
const VIEWPORTS = [
  { name: 'phone portrait', w: 390, h: 844, dpr: 3, mobile: true, minViewShare: 0.38 },
  { name: 'phone landscape', w: 844, h: 390, dpr: 3, mobile: true, minViewShare: 0.55 },
  { name: 'tablet portrait', w: 820, h: 1180, dpr: 2, mobile: true, minViewShare: 0.5 },
  { name: 'desktop', w: 1440, h: 900, dpr: 1, mobile: false, minViewShare: 0.5 },
];

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr,
    isMobile: vp.mobile, hasTouch: vp.mobile,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas', { timeout: 20000 });
  await page.waitForTimeout(2500);

  const m = await page.evaluate(() => {
    const scene = window.spatialScene();
    const canvas = document.querySelector('canvas.viewer-canvas').getBoundingClientRect();
    const pts = window.spatialStore.getState().assembly.parts
      .map((p) => scene.projectPart(p.id)).filter(Boolean);
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    return {
      view: [Math.round(canvas.width), Math.round(canvas.height)],
      viewShare: canvas.height / window.innerHeight,
      spanX: Math.max(...xs) - Math.min(...xs),
      spanY: Math.max(...ys) - Math.min(...ys),
      centreX: (Math.max(...xs) + Math.min(...xs)) / 2,
      centreY: (Math.max(...ys) + Math.min(...ys)) / 2,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      width: window.innerWidth, height: window.innerHeight,
    };
  });

  const tag = vp.name;
  // The assembly has to fill a real share of the frame along its longer axis.
  check(`${tag}: the assembly fills the view`, Math.max(m.spanX, m.spanY) > 0.35,
    `${(m.spanX * 100).toFixed(0)}% wide, ${(m.spanY * 100).toFixed(0)}% tall`);
  check(`${tag}: and is centred in it`,
    Math.abs(m.centreX - 0.5) < 0.12 && Math.abs(m.centreY - 0.5) < 0.15,
    `centre at ${m.centreX.toFixed(2)}, ${m.centreY.toFixed(2)}`);
  check(`${tag}: the 3D view gets its share of the screen`, m.viewShare >= vp.minViewShare,
    `${(m.viewShare * 100).toFixed(0)}% of the height (min ${(vp.minViewShare * 100).toFixed(0)}%)`);
  // A start screen that scrolls has already lost: the controls move under the
  // thumb and the model goes off the top.
  check(`${tag}: the page does not scroll`,
    m.scrollW <= m.width + 1 && m.scrollH <= m.height + 1,
    `${m.scrollW}x${m.scrollH} in ${m.width}x${m.height}`);

  // Every control has to be reachable without scrolling, and thumb-sized.
  const small = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('button, select')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(b).visibility === 'hidden') continue;
      if (r.height < 32) out.push(`${(b.textContent || b.tagName).trim().slice(0, 18)} ${Math.round(r.height)}px`);
      if (r.bottom > innerHeight + 1 || r.right > innerWidth + 1 || r.left < -1) {
        out.push(`${(b.textContent || b.tagName).trim().slice(0, 18)} off-screen`);
      }
    }
    return out;
  });
  if (vp.mobile) {
    check(`${tag}: every control is on screen and thumb-sized`, small.length === 0, small.join(', '));
  }

  await page.screenshot({ path: `${OUT}/${vp.name.replace(/ /g, '-')}.png` });
  await context.close();
}

// --- The HUD when the host disagrees about the viewport. -------------------
// Reported from an iPad running the app through the Needle App Clip: AR works,
// but the bottom bar and the step strip are sometimes not there.
//
// The app is a column as tall as the viewport with the HUD as its last row, and
// that row has to stay in the flow: iOS Safari anchors a `position: fixed`
// element to the *layout* viewport — the tall one without the toolbars — so a
// bar pinned to the bottom hides behind them, which is a check of its own in
// ar-verify. The column's height therefore has to be right, and `100dvh` is a
// guess. `--app-h` is measured from `visualViewport` instead.
{
  const cam = await chromium.launch(launchOptions(FAKE_CAMERA));
  for (const vp of [
    { name: 'tablet portrait', w: 820, h: 1180 },
    { name: 'tablet landscape', w: 1180, h: 820 },
    { name: 'phone portrait', w: 390, h: 844 },
  ]) {
    const context = await cam.newContext({
      viewport: { width: vp.w, height: vp.h }, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.click('.ar-enter');
    await page.waitForSelector('.ar-bar', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('.app').classList.add('xr-session'));

    // Twice: as opened, and after the visible area changes under the app — a
    // toolbar sliding in, a clip resizing its presentation, the device turning.
    for (const [when, size] of [['as opened', null], ['after the host resizes', { width: vp.w, height: vp.h - 220 }]]) {
      if (size) { await page.setViewportSize(size); await page.waitForTimeout(300); }
      const seen = await page.evaluate(() => {
        const box = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { bottom: Math.round(r.bottom), top: Math.round(r.top), h: Math.round(r.height) };
        };
        return {
          app: box('.app'), bar: box('.ar-bar'), now: box('.ar-now'),
          measured: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
          h: window.innerHeight,
        };
      });
      const on = (b) => b && b.h > 0 && b.bottom <= seen.h + 1 && b.top >= -1;
      check(`${vp.name}: the app measures the visible height rather than assuming it (${when})`,
        seen.measured === `${seen.h}px`, `--app-h ${seen.measured || 'unset'} for ${seen.h}px`);
      check(`${vp.name}: its box is no taller than what can be seen (${when})`,
        seen.app && seen.app.h <= seen.h + 1, `${seen.app?.h} of ${seen.h}`);
      check(`${vp.name}: the control bar is on screen (${when})`,
        on(seen.bar), seen.bar ? `bottom ${seen.bar.bottom} of ${seen.h}` : 'not rendered');
      check(`${vp.name}: and so is the step strip (${when})`,
        on(seen.now), seen.now ? `bottom ${seen.now.bottom} of ${seen.h}` : 'not rendered');
    }
    await context.close();
  }
  await cam.close();
}

// --- Motion, for an operator who asked for less of it. ---------------------
// One pulsing dot was covered by a reduced-motion rule and the other was not.
// That is how these rules usually go: written for the animation in front of
// you, and the next one lands somewhere else. None of the motion here carries
// meaning the still state does not, so under the preference it all stops.
{
  const quiet = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    reducedMotion: 'reduce',
  });
  const page = await quiet.newPage();
  await page.goto(`${URL}?assembly=kallax-4x4`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const moving = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const st = getComputedStyle(el);
      const duration = (v) => v.split(',').some((d) => parseFloat(d) > 0.01);
      if (st.animationName !== 'none' && duration(st.animationDuration)) {
        out.push(`${el.className || el.tagName} animates ${st.animationName}`);
      }
      if (duration(st.transitionDuration)) out.push(`${el.className || el.tagName} transitions`);
    }
    return out.slice(0, 6);
  });
  check('nothing animates when the operator has asked for reduced motion',
    moving.length === 0, moving.join(', ') || 'nothing moves');
  await quiet.close();
}

// --- Getting the panel out of the way. -------------------------------------
// A tester asked to be able to focus the 3D view. It was already possible —
// tapping the active tab collapses the sheet — and nothing on screen said so.
// An affordance, not a feature: the handle does what the tab already did.
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(2000);

  const share = () => page.evaluate(() => {
    const c = document.querySelector('canvas.viewer-canvas').getBoundingClientRect();
    return c.height / window.innerHeight;
  });
  const before = await share();
  const handle = page.locator('.sheet-handle');
  check('the panel says it can be got out of the way', await handle.count() === 1);
  const box = await handle.boundingBox().catch(() => null);
  check('and the handle is a thumb target', Boolean(box) && box.height >= 44,
    box ? `${Math.round(box.height)} px tall` : 'no handle');

  await handle.click();
  await page.waitForTimeout(500);
  const after = await share();
  check('and using it gives the 3D view the room',
    after > before + 0.1, `${Math.round(before * 100)}% → ${Math.round(after * 100)}% of the height`);
  check('and the handle goes with the panel it collapsed',
    await page.locator('.sheet-handle').count() === 0);
  await context.close();
}

// --- The assembly picker's options. ----------------------------------------
// Reported as "dropdown colours - flaw", and it was: the options inherited
// `--text` (#e6edf5, near white) while the operating system draws the popup on
// a light background of its own, so every unselected entry was near-white on
// white. Only the highlighted row could be read. The popup is drawn by the OS
// and cannot be screenshotted, but the colours the browser hands it can be read.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.assembly-picker');

  const colours = await page.evaluate(() => {
    const option = document.querySelector('.assembly-picker option');
    const select = document.querySelector('.assembly-picker');
    const st = getComputedStyle(option);
    return {
      colour: st.color,
      background: st.backgroundColor,
      scheme: getComputedStyle(select).colorScheme,
    };
  });
  const luminance = (css) => {
    const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const transparent = /rgba\(0, 0, 0, 0\)|transparent/.test(colours.background);
  check('the picker\'s options set their own background, not the popup\'s',
    !transparent, colours.background);
  check('and they are legible against it',
    !transparent && contrast(colours.colour, colours.background) >= 4.5,
    transparent ? 'no background to measure against'
      : `${contrast(colours.colour, colours.background).toFixed(1)}:1 (${colours.colour} on ${colours.background})`);
  check('and the control asks the OS for a dark popup',
    colours.scheme.includes('dark'), colours.scheme);
  await context.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall layout checks passed');
process.exit(failures.length ? 1 : 0);
