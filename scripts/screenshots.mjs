/**
 * Demo/e2e screenshot driver.
 *
 * Serves the built app (see `npm run preview`) and walks it through its real
 * states via the store handle exposed on `window.spatialStore`, capturing a PNG
 * for each. Uses the environment's pre-installed Chromium; override with
 * CHROME_PATH, and the target with PREVIEW_URL.
 *
 *   npm run build && npm run preview &   # serve dist on :4173
 *   node scripts/screenshots.mjs ./shots
 */
import { chromium } from 'playwright';
import { launchOptions } from './chrome.mjs';

const OUT = process.argv[2] ?? './shots';
const URL = process.env.PREVIEW_URL ?? 'http://localhost:4173/';

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas.viewer-canvas', { timeout: 15000 });
await page.waitForTimeout(2500);

const drive = (fn) => page.evaluate(fn);
const shot = async (name) => {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name);
};

const assembleActive = () =>
  drive(() => {
    const s = window.spatialStore.getState();
    for (const step of s.assembly.steps) {
      window.spatialStore.getState().setActiveStep(step.id);
      window.spatialStore.getState().autoPlaceActiveStep();
      window.spatialStore.getState().completeStep(step.id);
    }
  });

// 1) Guided view, first step active, ghosts visible.
await shot('01-guide');

// 2) Fully and correctly assembled — everything verified green.
await assembleActive();
await shot('02-assembled-green');

// 3) A real fault: swap the handed bearing caps.
await drive(() => {
  const parts = window.spatialStore.getState().assembly.parts;
  const left = parts.find((p) => p.id === 'cap-left');
  const right = parts.find((p) => p.id === 'cap-right');
  window.spatialStore.getState().placePart('cap-left', JSON.parse(JSON.stringify(right.targetPose)));
  window.spatialStore.getState().placePart('cap-right', JSON.parse(JSON.stringify(left.targetPose)));
  window.spatialStore.getState().selectPart('cap-left');
});
await shot('03-swap-error');

// 4) Exploded view.
await drive(() => {
  window.spatialStore.getState().selectPart(undefined);
  window.spatialStore.getState().setViewMode('explode');
  window.spatialStore.getState().setExplodeFactor(1.1);
});
await shot('04-exploded');

// 5) Large 110-part rack, fully assembled.
await page.selectOption('select.assembly-picker', { label: 'Modular Equipment Rack (14-bay)' }).catch(() => {});
await page.waitForTimeout(2500);
await drive(() => window.spatialStore.getState().setViewMode('guide'));
await assembleActive();
await shot('05-rack-assembled');

// 6) Rack exploded.
await drive(() => {
  window.spatialStore.getState().setViewMode('explode');
  window.spatialStore.getState().setExplodeFactor(0.9);
});
await shot('06-rack-exploded');

await browser.close();
console.log('done');
