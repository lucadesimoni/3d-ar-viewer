/**
 * Render the presence model's synthetic training set.
 *
 *   node scripts/presence/generate.mjs <outDir> [--views=4000] [--from=1] [--pages=3]
 *
 * Bundles `synth-entry.ts` with the app's own code, opens it in headless
 * Chromium and renders `views` randomised views (see that file for what is
 * randomised). Each view gives a crop per part the app would ask about. Writes
 * `crops-<from>.u8` (N × 96 × 96 × RGBA, the outline in alpha) and
 * `crops-<from>.jsonl` (one line per crop: label and where it came from).
 * Seeds are the view numbers, so a set can be regenerated exactly.
 */
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchOptions } from '../chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const args = process.argv.slice(2);
const out = resolve(args.find((a) => !a.startsWith('--')) ?? 'presence-data');
const opt = (name, def) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const views = opt('views', 4000);
const from = opt('from', 1);
const pages = opt('pages', 3);
mkdirSync(out, { recursive: true });

const scratch = mkdtempSync(join(tmpdir(), 'presence-synth-'));
const { build } = await import('vite');
await build({
  configFile: false, logLevel: 'silent', root: ROOT,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: scratch, emptyOutDir: true, minify: false,
    lib: { entry: join(HERE, 'synth-entry.ts'), formats: ['iife'], name: 'Synth', fileName: () => 'synth.js' },
  },
});
const code = readFileSync(join(scratch, 'synth.js'), 'utf8');

const bin = createWriteStream(join(out, `crops-${from}.u8`));
const meta = createWriteStream(join(out, `crops-${from}.jsonl`));
const browser = await chromium.launch(launchOptions());
let next = from;
const last = from + views - 1;
let crops = 0; let present = 0;
const started = Date.now();
const SIZES = [[480, 1040], [480, 853], [480, 640], [640, 480], [480, 1040]];

async function worker() {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: code });
  while (next <= last) {
    const seed = next++;
    const [width, height] = SIZES[seed % SIZES.length];
    let samples;
    try {
      samples = await page.evaluate((o) => window.synth.render(o), { seed, width, height });
    } catch (error) {
      console.error(`view ${seed}: ${String(error.message ?? error).split('\n')[0]}`);
      continue;
    }
    for (const s of samples) {
      bin.write(Buffer.from(s.rgba, 'base64'));
      const { rgba, ...rest } = s;
      meta.write(`${JSON.stringify({ ...rest, view: seed })}\n`);
      crops++; if (s.present) present++;
    }
    if (seed % 100 === 0) {
      const rate = (seed - from + 1) / ((Date.now() - started) / 1000);
      console.log(`view ${seed}/${last}: ${crops} crops (${Math.round((100 * present) / Math.max(1, crops))}% present), ${rate.toFixed(1)} views/s`);
    }
  }
  await page.close();
}

await Promise.all(Array.from({ length: pages }, worker));
await browser.close();
await new Promise((r) => bin.end(r));
await new Promise((r) => meta.end(r));
console.log(`done: ${crops} crops from ${views} views, ${present} present → ${out}`);
