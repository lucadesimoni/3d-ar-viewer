/**
 * Checks that the guidance actually points at the right geometry.
 *
 * Three claims are easy to make and easy to get quietly wrong, because all of
 * them look plausible in a screenshot: that the active step highlights its own
 * parts, that the labels on those parts name them correctly, and that "Show me"
 * animates the step's parts into place rather than teleporting them. Each is
 * asserted here against every step of every bundled assembly.
 *
 *   npm run build && npm run steps:check
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
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });

for (const assemblyId of ['kallax-4x4', 'bench-gearbox', 'equipment-rack']) {
  await page.goto(`${URL_BASE}?assembly=${assemblyId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(1500);
  const name = await page.evaluate(() => window.spatialStore.getState().assembly.name);

  // Every step: the labels drawn on the model belong to that step's parts.
  const labelled = await page.evaluate(async () => {
    const s = () => window.spatialStore.getState();
    const names = new Map(s().assembly.parts.map((p) => [p.id, p.name]));
    const bad = [];
    let steps = 0;
    let tagged = 0;
    const read = () => [...document.querySelectorAll('.step-tag-label')].map((e) => e.textContent);
    for (const step of s().assembly.steps) {
      s().setActiveStep(step.id);
      const expected = step.partIds.map((id) => names.get(id));
      // The labels are redrawn on an animation frame, so wait for them to
      // settle rather than guessing a delay. A fixed sleep made this check
      // fail about one run in three on a software renderer — and a flaky
      // check is worse than no check, because it teaches you to ignore it.
      let shown = read();
      for (let i = 0; i < 40 && shown.some((n) => !expected.includes(n)); i++) {
        await new Promise((r) => setTimeout(r, 25));
        shown = read();
      }
      steps++;
      tagged += shown.length;
      const wrong = shown.filter((n) => !expected.includes(n));
      if (wrong.length) bad.push(`${step.title}: ${wrong.join(', ')}`);
    }
    return { steps, tagged, bad };
  });
  check(`${name}: every on-part label belongs to its step`, labelled.bad.length === 0,
    `${labelled.steps} steps, ${labelled.tagged} labels${labelled.bad.length ? ` — ${labelled.bad[0]}` : ''}`);
  check(`${name}: steps are labelled at all`, labelled.tagged >= labelled.steps);

  // "Show me" moves the step's parts, and only those, and changes nothing.
  const anim = await page.evaluate(async () => {
    const s = () => window.spatialStore.getState();
    const step = s().assembly.steps.find((st) => st.partIds.length > 0);
    s().setActiveStep(step.id);
    await new Promise((r) => setTimeout(r, 250));

    const m = window.spatialScene();
    const nodeOf = (id) => m.scene.getTransformNodeByName('part-' + id);
    const before = new Map(s().assembly.parts.map((p) => [p.id, nodeOf(p.id)?.position.asArray()]));
    document.querySelector('.active-actions .ghost')?.click();
    await new Promise((r) => setTimeout(r, 350));

    const moved = [];
    for (const p of s().assembly.parts) {
      const a = before.get(p.id);
      const b = nodeOf(p.id)?.position.asArray();
      if (!a || !b) continue;
      if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 0.002) moved.push(p.id);
    }
    return {
      step: step.title,
      stepParts: step.partIds,
      moved,
      placedCount: [...s().placements.values()].filter((p) => p.status !== 'ghost').length,
    };
  });
  check(`${name}: "Show me" animates the step's own parts`,
    anim.moved.length > 0 && anim.moved.every((id) => anim.stepParts.includes(id)),
    `${anim.step}: moved ${anim.moved.length} of ${anim.stepParts.length}`);
  check(`${name}: and it demonstrates without changing the build`, anim.placedCount === 0,
    `${anim.placedCount} parts placed`);
}

// --- The Animate mode, which a tester read as broken. -----------------------
// "Animation doesn't seem to work yet." Entering the mode used to hide almost
// the whole model — `showGhosts` covered guide and explore only, and on an
// untouched build every part is a ghost, so all but the active step vanished
// and the timeline then moved the invisible. Nothing played by itself either,
// and the one button kept its "▶ / ❚❚" label whatever it was doing.
{
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.goto(`${URL_BASE}?assembly=bench-gearbox`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.viewer-canvas');
  await page.waitForTimeout(1800);

  // `isVisible`, not `isEnabled`: a hidden ghost stays enabled and only stops
  // being drawn. The first version of this check counted enabled meshes, so it
  // passed with the fix removed — it was measuring something that never changes.
  const visibleParts = () => page.evaluate(() => {
    const scene = window.spatialScene();
    return window.spatialStore.getState().assembly.parts.filter((p) => {
      const mesh = scene.scene.getMeshByName(`mesh-${p.id}`);
      return Boolean(mesh?.isEnabled() && mesh.isVisible);
    }).length;
  });
  const total = await page.evaluate(() => window.spatialStore.getState().assembly.parts.length);
  const inGuide = await visibleParts();

  await page.evaluate(() => window.spatialStore.getState().setViewMode('animate'));
  await page.waitForTimeout(400);
  const inAnimate = await visibleParts();
  check('entering Animate does not hide the assembly it is meant to animate',
    inAnimate >= inGuide, `${inAnimate} of ${total} parts visible (guide shows ${inGuide})`);

  // It has to move by itself: a mode whose whole point is motion, entered to
  // find a still picture, reads as broken.
  const samples = [];
  for (let i = 0; i < 4; i++) {
    samples.push(await page.evaluate(() => window.spatialStore.getState().animationT));
    await page.waitForTimeout(250);
  }
  const advanced = samples.filter((t, i) => i > 0 && t > samples[i - 1]).length;
  check('and it plays on arrival rather than waiting to be found',
    advanced >= 2, `t = ${samples.map((t) => t.toFixed(2)).join(' → ')}`);

  // And the button must say which of the two things it will do.
  const label = await page.locator('.scrubber .play').textContent();
  const pressed = await page.locator('.scrubber .play').getAttribute('aria-pressed');
  check('the play control shows its state instead of both glyphs at once',
    (label.trim() === '▶' || label.trim() === '❚❚') && ['true', 'false'].includes(pressed),
    `label "${label.trim()}", aria-pressed ${pressed}`);
  await page.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall step checks passed');
process.exit(failures.length ? 1 : 0);
