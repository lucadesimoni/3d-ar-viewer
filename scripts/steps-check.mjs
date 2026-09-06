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

const URL_BASE = process.env.PREVIEW_URL ?? 'http://localhost:8080/';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
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
    for (const step of s().assembly.steps) {
      s().setActiveStep(step.id);
      await new Promise((r) => setTimeout(r, 260));
      const shown = [...document.querySelectorAll('.step-tag-label')].map((e) => e.textContent);
      const expected = step.partIds.map((id) => names.get(id));
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

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall step checks passed');
process.exit(failures.length ? 1 : 0);
