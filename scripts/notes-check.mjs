/**
 * Operator notes: putting one on a part, and it staying on that part.
 *
 * The point of pinning a note to a component rather than to a spot in the room
 * is that it survives the things that move the room's contents — a re-placed
 * assembly, an exploded view, the build animation. That is the property worth
 * checking, and it is not visible in the code: it is visible in where the pin
 * ends up after the part has moved.
 *
 * Usage: node scripts/notes-check.mjs   (with the app served on PREVIEW_URL)
 */
import { chromium } from 'playwright';
import { launchOptions } from './chrome.mjs';

const URL = process.env.PREVIEW_URL ?? 'http://localhost:4173/';
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch(launchOptions());
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
});
const page = await context.newPage();
await page.goto(`${URL}?assembly=bench-gearbox`, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas.viewer-canvas');
await page.waitForTimeout(2500);

const notes = () => page.evaluate(() => window.spatialStore.getState().annotations);
const pin = () => page.evaluate(() => {
  const el = document.querySelector('.note-pin');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent };
});

// Enter the mode from the store, the way the button does.
await page.evaluate(() => window.spatialStore.getState().setAnnotating(true));
await page.waitForTimeout(200);
check('the mode says what to do', Boolean(await page.locator('.note-hint').count()));

// A tap on nothing must say so rather than drop a note nowhere.
await page.mouse.click(20, 120);
await page.waitForTimeout(200);
check('a tap on empty space adds nothing', (await notes()).length === 0);
check('and says why', (await page.locator('.note-hint.missed').count()) === 1);

// A tap on a part opens the composer, named for the part.
const target = await page.evaluate(() => {
  const scene = window.spatialScene();
  const part = window.spatialStore.getState().assembly.parts[0];
  const p = scene.projectPart(part.id);
  const canvas = document.querySelector('canvas.viewer-canvas').getBoundingClientRect();
  return { name: part.name, x: canvas.left + p.x * canvas.width, y: canvas.top + p.y * canvas.height };
});
await page.mouse.click(target.x, target.y);
await page.waitForTimeout(300);
const composer = await page.locator('.note-compose').count();
// Which part: whatever is frontmost at that pixel, which is not necessarily
// the one whose centre was projected — parts overlap. The composer names it,
// and that name is what the stored note has to agree with.
const named = (await page.locator('.note-compose strong').textContent().catch(() => '')) ?? '';
check('a tap on a part opens a note for that part', composer === 1, named || 'no composer');

await page.fill('.note-compose input', 'Burr on the mating face — filed');
await page.click('.note-compose button.primary');
await page.waitForTimeout(400);
const saved = await notes();
const onNamedPart = await page.evaluate((id) => {
  const part = window.spatialStore.getState().assembly.parts.find((p) => p.id === id);
  return part?.name ?? null;
}, saved[0]?.partId);
check('the note is kept, on the part it was written on',
  saved.length === 1 && onNamedPart === named,
  saved.length ? `${onNamedPart} (composer said ${named})` : 'none');
const placed = await pin();
// Where it was put, not merely somewhere on the part. The position is stored
// in the part's own frame; storing the world point instead would put the pin
// somewhere else entirely and still appear to "follow the part", so this is
// the assertion that tells those two apart.
const offBy = placed ? Math.hypot(placed.x - target.x, placed.y - target.y) : Infinity;
check('and shown where the operator touched', offBy < 40,
  placed ? `${Math.round(offBy)} px from the tap` : 'no pin');

// The property that makes a note useful: it rides the part.
await page.evaluate(() => {
  const store = window.spatialStore.getState();
  store.setViewMode('explode');
  store.setExplodeFactor(1.2);
});
await page.waitForTimeout(700);
const exploded = await pin();
check('and it follows the part when the view is exploded',
  Boolean(exploded) && (Math.abs(exploded.x - placed.x) > 4 || Math.abs(exploded.y - placed.y) > 4),
  exploded ? `moved to ${exploded.x},${exploded.y} from ${placed.x},${placed.y}` : 'pin lost');

// And it is still there tomorrow.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const afterReload = await notes();
check('and it survives a reload', afterReload.length === 1 && afterReload[0].text.includes('Burr'),
  afterReload.map((n) => n.text).join(', ') || 'none');

// Deleting: open the pin, then remove it.
await page.click('.note-pin');
await page.waitForTimeout(200);
await page.click('.note-delete');
await page.waitForTimeout(400);
check('a note can be taken back off', (await notes()).length === 0);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
check('and stays deleted', (await page.evaluate(() => window.spatialStore.getState().annotations)).length === 0);

// Placement and annotation both want the next tap. Only one may have it —
// and the rule lives in the controls, so this drives the controls.
{
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const wide = await desktop.newPage();
  await wide.goto(`${URL}?assembly=bench-gearbox`, { waitUntil: 'networkidle' });
  await wide.waitForSelector('canvas.viewer-canvas');
  await wide.waitForTimeout(2000);
  await wide.evaluate(() => window.spatialScene().setPlacementActive(true));
  await wide.click('.note-mode');
  await wide.waitForTimeout(300);
  const state = await wide.evaluate(() => ({
    noting: window.spatialStore.getState().annotating,
    placing: window.spatialScene().placing,
  }));
  check('turning noting on disarms the placement tap',
    state.noting === true && state.placing === false, JSON.stringify(state));
  await desktop.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall note checks passed');
process.exit(failures.length ? 1 : 0);
