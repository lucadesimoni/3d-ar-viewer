/**
 * The recognition benchmark: how well the app finds and aligns every sample
 * assembly, on rendered views where the truth is known.
 *
 *   node scripts/recognition/bench.mjs [--seeds=2] [--json=out.json] [--frames=dir] [--only=kallax-4x2]
 *
 * For each assembly, views from in front and from either side, high and low,
 * near and far, with and without clutter (`bench-entry.ts`). In each view:
 *  - registration from starts 5, 10 and 20 cm and 5 to 15 degrees off the
 *    truth, as a tapped or WebXR anchor is off;
 *  - where the assembly has a recognition target, the grid detector from
 *    nothing, and registration from its lock.
 *
 * Reported per assembly: how often registration accepted, how far off it
 * was when it did, and how often it accepted a pose that is visibly wrong
 * (the false accepts). The process exits non-zero if, for any assembly, false
 * accepts exceed `--max-false` of its trials (default 5%), so it can guard a
 * change. It takes about half an hour for every assembly.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchOptions } from '../chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const SEEDS = Number(opt('seeds', 2));
const ONLY = opt('only', '');
const FRAMES = opt('frames', '');
const JSON_OUT = opt('json', '');
const WORKING = Number(opt('working', 0)) || undefined;
const MAX_FALSE = Number(opt('max-false', 0.05));

/**
 * Good: the model's edges within 3 px of where the truth puts them, on
 * average, turned less than 1.5 degrees and within 5 cm. Along the line of
 * sight a few centimetres hardly change the picture, so the image error is
 * what the operator sees, and the metres are what the step check uses.
 * A false accept is an accepted pose more than 6 px out: visibly wrong.
 */
const GOOD_PX = 3;
const GOOD_DEG = 1.5;
const GOOD_M = 0.05;
const FALSE_PX = 6;

const ASSEMBLIES = ['bench-gearbox', 'kallax-4x2', 'kallax-4x4', 'jet-engine', 'equipment-rack'];
const VIEWS = [];
for (const azimuthDeg of [0, -35, 35]) {
  for (const elevationDeg of [10, 30]) {
    for (const fill of [0.8, 0.5]) {
      for (const clutter of [false, true]) VIEWS.push({ azimuthDeg, elevationDeg, fill, clutter, fovDeg: 62 });
    }
  }
}
/** [metres, bearing deg, yaw deg, height error m]. */
const STARTS = [
  [0.05, 0, 5, 0.005], [0.05, 120, -5, -0.005], [0.05, 240, 0, 0],
  [0.1, 60, 10, 0.01], [0.1, 180, -10, -0.01], [0.1, 300, 5, 0],
  [0.2, 30, 15, 0.01], [0.2, 210, -15, 0],
];

const scratch = mkdtempSync(join(tmpdir(), 'recognition-bench-'));
const { build } = await import('vite');
await build({
  configFile: false, logLevel: 'silent', root: ROOT,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: scratch, emptyOutDir: true, minify: false,
    lib: { entry: join(HERE, 'bench-entry.ts'), formats: ['iife'], name: 'Bench', fileName: () => 'bench.js' },
  },
});
const code = readFileSync(join(scratch, 'bench.js'), 'utf8');
const ids = await (async () => {
  const wanted = ONLY ? ONLY.split(',') : ASSEMBLIES;
  const unknown = wanted.filter((a) => !ASSEMBLIES.includes(a));
  if (unknown.length) throw new Error(`unknown assembly: ${unknown.join(', ')} (known: ${ASSEMBLIES.join(', ')})`);
  const known = wanted;
  return known;
})();

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.setContent('<!doctype html><body style="margin:0"></body>');
await page.addScriptTag({ content: code });
if (FRAMES) mkdirSync(FRAMES, { recursive: true });

const rows = [];
let n = 0;
for (const assemblyId of ids) {
  for (const view of VIEWS) {
    for (let s = 0; s < SEEDS; s++) {
      const seed = 1000 + n++;
      const bench = { assemblyId, ...view };
      const r = await page.evaluate((o) => window.bench.run(o), {
        seed, width: 480, height: 853, bench, starts: STARTS, keepFrame: Boolean(FRAMES), workingSize: WORKING,
      });
      if (FRAMES) {
        writeFileSync(join(FRAMES, `${seed}.rgba`), Buffer.from(r.frame.rgba, 'base64'));
        writeFileSync(join(FRAMES, `${seed}.json`), JSON.stringify({ seed, bench, width: r.frame.width, height: r.frame.height, outlines: r.outlines, trials: r.trials }));
      }
      rows.push({ seed, ...bench, trials: r.trials, grid: r.grid });
    }
  }
  process.stdout.write(`${assemblyId} done\n`);
}
await browser.close();

const good = (t) => t.afterPx <= GOOD_PX && t.after.deg <= GOOD_DEG && t.after.m <= GOOD_M;
const lockGood = (e) => e.m <= GOOD_M && e.deg <= GOOD_DEG;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const median = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const summary = {};
console.log('\nRegistration from a start a known distance off (all views):');
console.log('assembly          clutter trials accepted good/acc false-acc  px before→after  cm after  deg after   ms');
for (const assemblyId of ids) {
  for (const clutter of [false, true]) {
    const ts = rows.filter((r) => r.assemblyId === assemblyId && r.clutter === clutter).flatMap((r) => r.trials.filter((t) => t.start !== 'grid lock'));
    const acc = ts.filter((t) => t.result.accepted);
    const line = {
      trials: ts.length, accepted: acc.length, good: acc.filter(good).length,
      falseAccepts: acc.filter((t) => t.afterPx > FALSE_PX).length,
      pxBefore: median(ts.map((t) => t.beforePx)), pxAfter: median(acc.map((t) => t.afterPx)),
      cmAfter: median(acc.map((t) => t.after.m * 100)), degAfter: median(acc.map((t) => t.after.deg)),
      ms: median(ts.map((t) => t.ms)),
    };
    summary[`${assemblyId}${clutter ? '+clutter' : ''}`] = line;
    console.log(`${assemblyId.padEnd(17)} ${String(clutter).padEnd(7)} ${String(line.trials).padStart(6)} ${pct(line.accepted, line.trials).padStart(8)} ${pct(line.good, line.accepted).padStart(8)} ${String(line.falseAccepts).padStart(9)}  ${line.pxBefore.toFixed(1).padStart(6)} → ${line.pxAfter.toFixed(1).padEnd(6)} ${line.cmAfter.toFixed(1).padStart(8)} ${line.degAfter.toFixed(1).padStart(9)} ${line.ms.toFixed(0).padStart(5)}`);
  }
}
const withGrid = rows.filter((r) => r.grid);
if (withGrid.length) {
  console.log('\nGrid detector from nothing, and registration from its lock:');
  for (const assemblyId of ids) {
    const rs = withGrid.filter((r) => r.assemblyId === assemblyId);
    if (!rs.length) continue;
    const locked = rs.filter((r) => r.grid.locked);
    const lockedGood = locked.filter((r) => lockGood(r.grid.error));
    const refined = locked.map((r) => r.trials.find((t) => t.start === 'grid lock')).filter(Boolean);
    const refAcc = refined.filter((t) => t.result.accepted);
    console.log(`${assemblyId}: locked ${locked.length}/${rs.length}, lock within 5 cm and 1.5° ${lockedGood.length}/${locked.length}, median lock error ${(median(locked.map((r) => r.grid.error.m)) * 100).toFixed(1)} cm ${median(locked.map((r) => r.grid.error.deg)).toFixed(1)}°, ${median(refined.map((t) => t.beforePx)).toFixed(1)} px`);
    console.log(`  registration from the lock: accepted ${refAcc.length}/${refined.length}, good ${refined.filter(good).length}/${refined.length}, false ${refAcc.filter((t) => t.afterPx > FALSE_PX).length}, median after ${median(refined.map((t) => t.afterPx)).toFixed(1)} px`);
    summary[`${assemblyId}:grid`] = { views: rs.length, locked: locked.length, lockGood: lockedGood.length, refinedAccepted: refAcc.length, refinedGood: refined.filter(good).length };
    const outcomes = {};
    rs.filter((r) => !r.grid.locked).forEach((r) => { outcomes[r.grid.outcome] = (outcomes[r.grid.outcome] ?? 0) + 1; });
    if (Object.keys(outcomes).length) console.log(`  not locked: ${JSON.stringify(outcomes)}`);
  }
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, rows }, null, 1));
const over = Object.entries(summary).filter(([, l]) => l.trials && l.falseAccepts > MAX_FALSE * l.trials);
if (over.length) {
  console.error(`\nToo many false accepts (budget ${MAX_FALSE * 100}% of trials): ${over.map(([k, l]) => `${k} ${l.falseAccepts}/${l.trials}`).join(', ')}`);
  process.exitCode = 1;
}
