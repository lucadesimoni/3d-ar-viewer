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
import { launchOptions } from './chrome.mjs';
import { createChecks } from './checks.mjs';
import { cp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const PORT = Number(process.env.PORT ?? 4319);
const WORK = '/tmp/deploy-check';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

const { check, finish } = createChecks();

// --- 0. What a first visit has to download before anything paints. ----------
// Measured 2026-09-23 on a 4G-like link with 4x CPU throttling: 57 preloaded
// files and 2.66 MB of JS put first paint at 1.83 s, because the glTF loader
// registered every extension (FlowGraph, the audio engine, Gaussian splats) and
// the whole renderer was a static import. After making both load on demand: 4
// files, 443 KB, first paint 0.95 s. The budget is that plus about a third, so
// ordinary growth passes and a renderer creeping back into the preload does not.
const PRELOAD_BUDGET_KB = 600;
const indexHtml = await readFile('dist/index.html', 'utf8');
const preloaded = [...indexHtml.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
let preloadBytes = 0;
for (const f of preloaded) preloadBytes += (await readFile(`dist/${f}`)).length;
const unwanted = preloaded.filter((f) => /flowGraph|webAudio|abstractSound|sound|gaussian/i.test(f));
check('the first paint does not wait for audio or FlowGraph code', unwanted.length === 0,
  unwanted.join(', ') || 'none preloaded');
check(`the first paint waits for at most ${PRELOAD_BUDGET_KB} KB of JavaScript`,
  preloadBytes / 1024 <= PRELOAD_BUDGET_KB,
  `${preloaded.length} files, ${Math.round(preloadBytes / 1024)} KB`);

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
// Lazy chunks import shared code from the entry too. Left pointing at the old
// name, B was broken for any visitor without A's copy cached — the renderer
// failed to load and the redeploy checks only passed on the worker's cache.
for (const f of assets.filter((a) => a.endsWith('.js') && a !== entry)) {
  const code = await readFile(`${WORK}/b/assets/${f}`, 'utf8');
  if (code.includes(entry)) await writeFile(`${WORK}/b/assets/${f}`, code.replaceAll(entry, renamed));
}

// --- A deliberately dumb static host: no SPA fallback beyond index.html, no
// caching headers, nothing our own server would add. ------------------------
let root = `${WORK}/a`;
// "Offline" means the host is unreachable, for everyone. Playwright's offline
// switch only reaches the page: a service worker's own fetches still went out
// and were answered, so the offline checks passed whatever the worker cached.
let hostDown = false;
const server = createServer(async (req, res) => {
  if (hostDown) { req.socket.destroy(); return; }
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

const browser = await chromium.launch(launchOptions());
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();
// Offline visits must be answered by the service worker, not the browser's own
// HTTP cache — which happily serves every bundle of the last visit with the
// network gone, and so made an offline check pass whatever the worker cached.
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
const httpCache = (on) => cdp.send('Network.setCacheDisabled', { cacheDisabled: !on });

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

// Booted means the 3D view actually drew a frame. The canvas element and the
// store are React's and exist even when the renderer failed to load, so a check
// on them alone passed an offline visit that had no 3D view at all.
const booted = async () => {
  await page.waitForSelector('canvas.viewer-canvas', { timeout: 20000 }).catch(() => null);
  await page.waitForFunction(() => (window.spatialScene?.()?.renderStats().frames ?? 0) > 0,
    undefined, { timeout: 20000 }).catch(() => null);
  return page.evaluate(() => Boolean(document.querySelector('canvas.viewer-canvas') && window.spatialStore
    && (window.spatialScene?.()?.renderStats().frames ?? 0) > 0));
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
hostDown = true;
await httpCache(false);
problems.length = 0;
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' }).catch(() => null);
check('it still opens with no network, 3D view included', await booted(), 'served by the service worker');
await context.setOffline(false);
hostDown = false;
await httpCache(true);

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
hostDown = true;
await httpCache(false);
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' }).catch(() => null);
check('the new build is offline-capable too', await booted());
await context.setOffline(false);
hostDown = false;
await httpCache(true);

// --- 5. The renderer never arrives. ---------------------------------------
// A first visit that loses the connection between the page and the 3D chunk
// (or a device with no WebGL) used to leave an empty stage that said nothing.
// It must say so, hold the AR button back, and come back on "Try again".
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p2 = await ctx.newPage();
  let blockRenderer = true;
  await p2.route(/\/assets\/SceneManager-[^/]*\.js$/, (route) => (blockRenderer ? route.abort('failed') : route.continue()));
  await p2.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  const failedShown = await p2.waitForSelector('.viewer-status.failed', { timeout: 20000 }).then(() => true, () => false);
  check('a renderer that does not load says so, with a way to retry', failedShown
    && /could not load/.test(await p2.locator('.viewer-status.failed').innerText()));
  blockRenderer = false;
  // A chunk that failed once is remembered as failed by the browser, so the
  // retry is a reload; wait for it rather than poll a page being replaced.
  await Promise.all([
    p2.waitForEvent('load', { timeout: 20000 }).catch(() => null),
    p2.locator('.viewer-status.failed button').click().catch(() => null),
  ]);
  const recovered = await p2.waitForFunction(() => (window.spatialScene?.()?.renderStats().frames ?? 0) > 0,
    undefined, { timeout: 20000 }).then(() => true, () => false);
  const leftover = await p2.locator('.viewer-status').count().catch(() => -1);
  check('and "Try again" brings the 3D view back', recovered && leftover === 0,
    `drawing: ${recovered}, status overlays left: ${leftover}`);
  await ctx.close();
}

// While the renderer is still on its way, AR entry waits for it.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p3 = await ctx.newPage();
  let release;
  const held = new Promise((r) => { release = r; });
  await p3.route(/\/assets\/SceneManager-[^/]*\.js$/, async (route) => { await held; await route.continue(); });
  await p3.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await p3.waitForSelector('.viewer-status', { timeout: 20000 }).catch(() => null);
  const whileLoading = await p3.evaluate(() => [...document.querySelectorAll('.ar-enter')]
    .map((b) => ({ visible: b.getClientRects().length > 0, disabled: b.disabled, label: b.textContent })));
  const visible = whileLoading.filter((b) => b.visible);
  check('AR entry waits for the 3D view, and says it is loading', visible.length > 0
    && visible.every((b) => b.disabled && /Enter AR/.test(b.label ?? ''))
    && /Loading the 3D view/.test(await p3.locator('.viewer-status').innerText().catch(() => '')),
    JSON.stringify(whileLoading));
  release();
  await p3.waitForFunction(() => (window.spatialScene?.()?.renderStats().frames ?? 0) > 0,
    undefined, { timeout: 20000 }).catch(() => null);
  const enabled = await p3.evaluate(() => [...document.querySelectorAll('.ar-enter')]
    .filter((b) => b.getClientRects().length > 0).every((b) => !b.disabled));
  check('and is available once it is there', enabled);
  await ctx.close();
}

await browser.close();
server.close();
finish('all deployment checks passed');
