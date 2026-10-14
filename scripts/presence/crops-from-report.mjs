/**
 * Real training and test crops, from diagnostics reports sent from devices.
 *
 *   node scripts/presence/crops-from-report.mjs <outDir> <report.json>… [--present] [--roi]
 *
 * A capture in a report carries the frame and, for every part, its expected
 * outline in that frame and whether the app counted it as fitted. This cuts the
 * crop the app's presence model is shown for each part on screen, with the
 * same code (`presenceInput.ts`), labelled by `fitted`, and writes them in the
 * format `generate.mjs` writes, so `train.py` reads real and synthetic alike.
 *
 *  --present  label every part present: for a report of a finished assembly
 *             whose step ticks were not kept.
 *  --roi      older reports have no outline, only a rectangle: use it. A
 *             rectangle is not the outline the model was trained with, so
 *             crops cut this way are good for testing, not training.
 *
 * Reports hold camera pictures of somebody's room: keep the output out of the
 * repository.
 */
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchOptions } from '../chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [outDir, ...reports] = args.filter((a) => !a.startsWith('--'));
if (!outDir || reports.length === 0) {
  console.error('usage: crops-from-report.mjs <outDir> <report.json>… [--present] [--roi]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const scratch = mkdtempSync(join(tmpdir(), 'presence-report-'));
const { build } = await import('vite');
await build({
  configFile: false, logLevel: 'silent', root: ROOT,
  build: { outDir: scratch, emptyOutDir: true, lib: { entry: join(HERE, 'report-entry.ts'), formats: ['iife'], name: 'R', fileName: () => 'r.js' } },
});
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
await page.addScriptTag({ content: readFileSync(join(scratch, 'r.js'), 'utf8') });

let total = 0;
for (const path of reports) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const name = basename(path, '.json').slice(0, 40);
  const bin = createWriteStream(join(outDir, `crops-report-${name}.u8`));
  const meta = createWriteStream(join(outDir, `crops-report-${name}.jsonl`));
  for (const [i, capture] of (report.captures ?? []).entries()) {
    if (!capture.image) continue;
    const parts = capture.parts.filter((p) => p.onScreen && !p.roiClipped && (p.outline || (flags.has('--roi') && p.roi)));
    const outlines = parts.map((p) => p.outline ?? (([x, y, w, h]) => [x, y, x + w, y, x + w, y + h, x, y + h])(p.roi));
    const src = capture.image.startsWith('data:') ? capture.image : `data:image/jpeg;base64,${capture.image}`;
    const crops = await page.evaluate(([s, o]) => window.reportCrops(s, o), [src, outlines]);
    parts.forEach((p, k) => {
      if (!crops[k]) return;
      bin.write(Buffer.from(crops[k], 'base64'));
      meta.write(`${JSON.stringify({
        present: flags.has('--present') ? true : Boolean(p.fitted), partId: p.id,
        assembly: report.assembly?.id ?? 'unknown', view: `${name}#${i}`, source: p.outline ? 'outline' : 'roi',
      })}\n`);
      total++;
    });
  }
  await new Promise((r) => bin.end(r)); await new Promise((r) => meta.end(r));
}
await browser.close();
console.log(`${total} crops → ${outDir}`);
