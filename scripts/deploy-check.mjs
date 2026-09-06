/**
 * Checks the app against a *plain static host* — Vercel, Netlify, S3 — rather
 * than against `server/serve.mjs`.
 *
 * The custom server sets caching, permissions and SPA-fallback headers that a
 * static host does not, so "it works locally" proves nothing about the deployed
 * app. Worse, the failure that matters most only appears on the second
 * deployment: a service worker that serves the cached HTML shell hands the
 * browser an index.html from the previous build, whose fingerprinted bundles no
 * longer exist on the host. That is a blank screen, and it is invisible until
 * you redeploy.
 *
 * So this serves the real build from a directory it can swap underneath the
 * browser, and walks the sequence a user actually experiences: first visit,
 * offline visit, and a visit after a redeploy.
 *
 *   npm run build && npm run deploy:check
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { cp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.PORT ?? 4319);
const WORK = '/tmp/deploy-check';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// --- Two "deployments" of the same app, differing only in bundle names. ------
await rm(WORK, { recursive: true, force: true });
await cp('dist', `${WORK}/a`, { recursive: true });
await cp('dist', `${WORK}/b`, { recursive: true });

// Rename the entry bundle in B and repoint index.html at it — exactly what a
// redeploy looks like to a browser holding a cached shell.
const assets = await readdir(`${WORK}/b/assets`);
const entry = assets.find((f) => f.startsWith('index-') && f.endsWith('.js'));
if (!entry) { console.error('no entry bundle found in dist/assets'); process.exit(1); }
const renamed = entry.replace(/^index-/, 'index-redeploy');
await rename(`${WORK}/b/assets/${entry}`, `${WORK}/b/assets/${renamed}`);
const html = await readFile(`${WORK}/b/index.html`, 'utf8');
await writeFile(`${WORK}/b/index.html`, html.replaceAll(entry, renamed));

// --- A deliberately dumb static host: no SPA fallback beyond index.html, no
// caching headers, nothing our own server would add. ------------------------
let root = `${WORK}/a`;
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(root, path === '/' ? '/index.html' : path);
  if (!existsSync(file) || !extname(file)) file = join(root, 'index.html');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));
const URL_BASE = `http://localhost:${PORT}/`;

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();

// Third-party CDNs (OpenCV, ONNX) are optional by design and may be blocked by
// the network this runs on; their absence is not a deployment defect, and the
// app is expected to keep working without them.
const EXTERNAL = /docs\.opencv\.org|cdn\.jsdelivr|unpkg\.com|ERR_TUNNEL/;
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => {
  // Navigating away cancels whatever was still in flight; that is the browser
  // being sensible, not the deployment being broken.
  const why = r.failure()?.errorText ?? '';
  if (/ERR_ABORTED/.test(why)) return;
  problems.push(`failed: ${r.url()} (${why})`);
});
page.on('response', (r) => { if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`); });

const booted = async () => {
  await page.waitForSelector('canvas.viewer-canvas', { timeout: 20000 }).catch(() => null);
  return page.evaluate(() => Boolean(document.querySelector('canvas.viewer-canvas') && window.spatialStore));
};

// --- 1. First visit on a plain host. ---------------------------------------
await page.goto(URL_BASE, { waitUntil: 'networkidle' });
check('the app boots on a static host with no custom headers', await booted());
const firstLoad = problems.filter((p) => !EXTERNAL.test(p));
check('nothing failed to load', firstLoad.length === 0, firstLoad.slice(0, 3).join(' | ') || 'clean');

const swReady = await page.evaluate(() =>
  navigator.serviceWorker.ready.then((r) => Boolean(r.active)).catch(() => false));
check('the service worker installs and activates', swReady);

// --- 2. Offline. -----------------------------------------------------------
await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));   // let it cache
await context.setOffline(true);
problems.length = 0;
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' }).catch(() => null);
check('it still opens with no network', await booted(), 'app shell served from cache');
await context.setOffline(false);

// --- 3. Redeploy: same URL, new bundle names. ------------------------------
root = `${WORK}/b`;
problems.length = 0;
await page.goto(URL_BASE, { waitUntil: 'networkidle' });
const bootedAfter = await booted();
check('it still boots after a redeploy', bootedAfter);
const scripts = await page.evaluate(() =>
  [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')));
check('and it runs the newly deployed bundle, not the cached one',
  scripts.some((s) => s?.includes('index-redeploy')), scripts.join(', '));
// A static host answers a missing bundle with its SPA fallback — 200 and HTML —
// so a 404 check would miss the very failure this exists to catch. The symptom
// is the module loader refusing the HTML it was handed, on the console.
const local = problems.filter((p) => !EXTERNAL.test(p));
check('with no failed requests or module errors', local.length === 0,
  local.slice(0, 3).join(' | ') || 'clean');

// --- 4. And offline again, on the new build. -------------------------------
await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
await context.setOffline(true);
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' }).catch(() => null);
check('the new build is offline-capable too', await booted());
await context.setOffline(false);

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall deployment checks passed');
process.exit(failures.length ? 1 : 0);
