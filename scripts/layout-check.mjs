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
import { launchOptions } from './chrome.mjs';

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

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall layout checks passed');
process.exit(failures.length ? 1 : 0);
