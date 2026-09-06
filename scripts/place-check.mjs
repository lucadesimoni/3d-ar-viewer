/**
 * Checks that a person can actually place a part, and that it snaps.
 *
 * The snap solver, the tolerance bands and the fit verification were reachable
 * only from tests: nothing in the interface moved a part, so the feature that
 * the whole app is named for could not be exercised by hand. This drags parts
 * with a real pointer and measures where they end up.
 *
 *   npm run build && npm run place:check
 */
import { chromium } from 'playwright';
import { launchOptions } from './chrome.mjs';

const URL_BASE = process.env.PREVIEW_URL ?? 'http://localhost:8080/';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
await page.goto(`${URL_BASE}?assembly=bench-gearbox`, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas.viewer-canvas');
await page.waitForTimeout(1500);

// --- 1. The step's "Place" action seats the parts through the snap solver. ---
const placed = await page.evaluate(async () => {
  const s = () => window.spatialStore.getState();
  s().setActiveStep(s().assembly.steps[0].id);
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('.active-actions .secondary')?.click();
  await new Promise((r) => setTimeout(r, 300));
  const step = s().assembly.steps[0];
  const byId = new Map(s().assembly.parts.map((p) => [p.id, p]));
  return step.partIds.map((id) => {
    const pl = s().placements.get(id);
    const target = byId.get(id).targetPose.position;
    const d = Math.hypot(
      pl.pose.position[0] - target[0], pl.pose.position[1] - target[1], pl.pose.position[2] - target[2],
    );
    return { id, status: pl.status, mm: +(d * 1000).toFixed(2) };
  });
});
check('the step\'s Place action puts the parts in', placed.every((p) => p.status !== 'ghost'),
  placed.map((p) => `${p.id}=${p.status}`).join(', '));
check('and they end up seated, not 20 mm out where they were released',
  placed.every((p) => p.mm < 1), placed.map((p) => `${p.id} ${p.mm}mm`).join(', '));

// --- 2. Dragging a part with a pointer, and letting go, snaps it. -----------
const canvas = await page.locator('canvas.viewer-canvas').boundingBox();
const screenOf = (partId) => page.evaluate((id) => {
  const p = window.spatialScene().projectPart(id);
  return p ? { x: p.x, y: p.y, onScreen: p.onScreen } : null;
}, partId);

// Put the housing in reach: place its predecessor, then drag the housing itself.
await page.evaluate(async () => {
  const s = () => window.spatialStore.getState();
  s().setActiveStep('s2');
  await new Promise((r) => setTimeout(r, 200));
});
const housing = await screenOf('housing');
check('the part to drag is on screen', Boolean(housing?.onScreen));

const from = { x: canvas.x + housing.x * canvas.width, y: canvas.y + housing.y * canvas.height };
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(from.x + 7, from.y - 5, { steps: 8 });   // a few mm off the joint
await page.mouse.up();
await page.waitForTimeout(400);

const result = await page.evaluate(() => {
  const s = window.spatialStore.getState();
  const part = s.assembly.parts.find((p) => p.id === 'housing');
  const pl = s.placements.get('housing');
  const t = part.targetPose.position;
  return {
    status: pl.status,
    mm: +(Math.hypot(pl.pose.position[0] - t[0], pl.pose.position[1] - t[1], pl.pose.position[2] - t[2]) * 1000).toFixed(2),
    snapped: Boolean(s.lastSnap && s.lastSnap.partId === 'housing'),
    residualMm: s.lastSnap ? +s.lastSnap.residual.positionMm.toFixed(2) : null,
  };
});
check('a dragged part is placed on release', result.status !== 'ghost', `status=${result.status}`);
check('and the snap solver seats it on the joint', result.snapped && result.mm < 2,
  `${result.mm} mm from nominal, snap residual ${result.residualMm} mm`);

// --- 3. Dropped well outside capture range: no silent snap, a real error. ---
const far = await page.evaluate(async () => {
  const s = () => window.spatialStore.getState();
  const part = s().assembly.parts.find((p) => p.id === 'housing');
  const t = part.targetPose.position;
  s().placePart('housing', { position: [t[0] + 0.14, t[1], t[2]], rotation: part.targetPose.rotation });
  await new Promise((r) => setTimeout(r, 250));
  const pl = s().placements.get('housing');
  return {
    mm: +(Math.hypot(pl.pose.position[0] - t[0], pl.pose.position[1] - t[1], pl.pose.position[2] - t[2]) * 1000).toFixed(1),
    errors: s().diagnostics.filter((d) => d.severity === 'error' && d.partIds.includes('housing')).map((d) => d.code),
  };
});
check('a part dropped out of range is not silently teleported home', far.mm > 100, `${far.mm} mm out`);
check('and the operator is told why it is wrong', far.errors.length > 0, far.errors.join(', ') || 'no diagnostic');

await page.screenshot({ path: '/tmp/place-check.png' });
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall placement checks passed');
process.exit(failures.length ? 1 : 0);
