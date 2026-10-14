/**
 * The app inside the native shells, with the shell simulated.
 *
 *   node scripts/native-check.mjs   (with the app served on PREVIEW_URL)
 *
 * The Android (ARCore) and iOS (ARKit) apps in `native/` show this web app over
 * their camera and drive it through `src/native/bridge.ts`. Neither can run
 * here: no phone, no AR runtime. So this plays the shell's part exactly as the
 * protocol says it does: it answers `start` with `hello` and a pose stream,
 * finds a floor, hands over camera frames of a cube shelf when asked, and
 * records what the page sends. Then it checks what an operator would see:
 *  - the app's own AR, not the browser's camera or WebXR;
 *  - a page the camera shows through;
 *  - an overlay that stays put as the phone walks, which the browser could
 *    never do on an iPhone;
 *  - a tap that lands on the floor the shell measured;
 *  - recognition and the step check, fed by the shell's frames;
 *  - Exit, which tells the shell to stop.
 * Outside the shell it checks the "Open in the app" link.
 */
import { chromium } from 'playwright';
import { launchOptions } from './chrome.mjs';
import { createChecks, PREVIEW_URL } from './checks.mjs';

const URL = PREVIEW_URL;
const { check, finish } = createChecks();
const browser = await chromium.launch(launchOptions());

/** The simulated shell, installed before the page's own scripts. */
const FAKE_SHELL = ({ platform, answer }) => {
  const sent = [];
  window.__shell = { sent, walkZ: 0, floorY: undefined, posesSent: 0, imagesSent: 0, cameraUsed: false, xrAsked: false };
  const receive = (m) => window.spatialNative?.receive(JSON.stringify(m));
  let timer;
  const pose = () => ({
    type: 'pose', t: performance.now(), fovDeg: 60, tracking: 'normal',
    // Eye height 1.4 m above the floor at y = 0, looking level down -z, walked by walkZ.
    pose: { position: [0, 1.4, window.__shell.walkZ], rotation: [0, 0, 0, 1] },
    ...(window.__shell.floorY !== undefined ? { floorY: window.__shell.floorY } : {}),
  });
  /** A cube shelf, 4 x 2, ahead and below: what the camera would see. */
  const shelfImage = (maxWidth) => {
    const c = document.createElement('canvas'); c.width = Math.min(640, maxWidth); c.height = Math.round(c.width * 0.75);
    const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
    const span = c.width * 0.62; const cols = 4; const rows = 2; const spanY = (span / cols) * rows;
    const left = (c.width - span) / 2; const top = (c.height - spanY) / 2; const b = span * 0.0204;
    g.fillStyle = '#ebebeb'; g.fillRect(left, top, span, spanY);
    g.fillStyle = '#2a2a2a';
    const px = (span - b) / cols; const py = (spanY - b) / rows;
    for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) g.fillRect(left + b + k * px, top + b + r * py, px - b, py - b);
    return { image: c.toDataURL('image/jpeg', 0.9), width: c.width, height: c.height };
  };
  const handle = (m) => {
    sent.push(m.type);
    if (!answer) return;
    if (m.type === 'start') {
      receive({ type: 'hello', version: 1, platform, appVersion: 'test', cameraImages: true });
      receive({ type: 'session', state: 'running' });
      clearInterval(timer);
      timer = setInterval(() => { window.__shell.posesSent++; receive(pose()); }, 33);
    } else if (m.type === 'stop') {
      clearInterval(timer);
    } else if (m.type === 'request-image') {
      window.__shell.imagesSent++;
      const img = shelfImage(m.maxWidth);
      receive({ type: 'camera-image', t: performance.now(), ...img, pose: pose().pose, fovDeg: 60 });
    }
  };
  if (platform === 'android') {
    window.SpatialNativeHost = { postMessage: (json) => handle(JSON.parse(json)) };
  } else {
    window.webkit = { messageHandlers: { spatialNative: { postMessage: (m) => handle(m) } } };
  }
  // The shell owns the camera and offers no WebXR: neither may be asked for.
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.__shell.cameraUsed = true; throw new Error('no camera here'); };
  if (navigator.xr) navigator.xr.requestSession = async () => { window.__shell.xrAsked = true; throw new Error('no xr here'); };
};

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: ANDROID_UA };

async function enter(page) {
  await page.waitForSelector('canvas.viewer-canvas', { timeout: 20000 });
  await page.waitForFunction(() => (window.spatialScene?.()?.renderStats().frames ?? 0) > 0, undefined, { timeout: 20000 });
  await page.locator('.ar-enter').first().click();
}

const scene = (page) => page.evaluate(() => {
  const s = window.spatialStore.getState();
  const m = window.spatialScene?.();
  return {
    source: s.arSource, placement: s.arPlacement, anchor: s.anchor?.position ?? null,
    camera: m?.cameraPose().position ?? null, error: s.arError ?? null,
  };
});

// --- Outside the shell: the web app, with the way into the app when it is there. ---
for (const installed of [false, true]) {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  // What Chrome on Android answers, from the manifests on both sides.
  await page.addInitScript((has) => {
    navigator.getInstalledRelatedApps = async () => (has ? [{ platform: 'play', id: 'com.outthinkx.spatialar' }] : []);
  }, installed);
  await page.goto(`${URL}?assembly=kallax-4x2`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const href = await page.locator('a.native-app').first().getAttribute('href', { timeout: 1000 }).catch(() => null);
  if (installed) {
    check('Android with the app installed: "Open in the Spatial AR app", carrying the job',
      Boolean(href?.startsWith('intent://open?url=')) && href.includes('package=com.outthinkx.spatialar')
        && href.includes('S.browser_fallback_url=') && decodeURIComponent(href).includes('assembly=kallax-4x2'),
      href ?? 'no link');
  } else {
    check('Android without the app: the web app alone, no link to an app that is not there', href === null, href ?? 'no link');
  }
  await context.close();
}

// The web app is installable on its own: the PWA baseline on both platforms.
{
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  const pwa = await page.evaluate(async () => {
    const manifest = await (await fetch(document.querySelector('link[rel=manifest]').href)).json();
    const touch = document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href');
    const sizes = await Promise.all(manifest.icons.filter((i) => i.type === 'image/png').map(async (i) => {
      const img = new Image(); img.src = i.src; await img.decode(); return { ...i, w: img.naturalWidth };
    }));
    const touchImg = new Image(); touchImg.src = touch; await touchImg.decode().catch(() => undefined);
    return {
      display: manifest.display, startUrl: manifest.start_url,
      png: sizes.map((i) => `${i.w}${i.purpose === 'maskable' ? 'm' : ''}`),
      touch, touchW: touchImg.naturalWidth,
      related: manifest.related_applications?.[0]?.id, prefer: manifest.prefer_related_applications,
      sw: Boolean(await navigator.serviceWorker?.getRegistration()),
    };
  });
  check('the web app installs on its own, on Android and iOS',
    pwa.display === 'standalone' && pwa.png.includes('192') && pwa.png.includes('512') && pwa.png.includes('512m')
      && pwa.touch?.endsWith('.png') && pwa.touchW === 180 && pwa.prefer === false && pwa.related === 'com.outthinkx.spatialar',
    JSON.stringify(pwa));
  await context.close();
}

// --- Inside the shell (Android, then iOS's message handler). ------------------------
for (const platform of ['android', 'ios']) {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(FAKE_SHELL, { platform, answer: true });
  await page.goto(`${URL}?assembly=kallax-4x2`, { waitUntil: 'networkidle' });
  const linkInShell = await page.locator('a.native-app').count();
  check(`${platform}: inside the app, no link to the app`, linkInShell === 0);
  await enter(page);
  await page.waitForFunction(() => window.spatialStore.getState().arSource === 'native', undefined, { timeout: 8000 }).catch(() => null);
  let s = await scene(page);
  const shell = await page.evaluate(() => ({ ...window.__shell }));
  check(`${platform}: AR runs on the app's own tracking`, s.source === 'native' && shell.sent.includes('start'),
    `source ${s.source}, sent ${shell.sent.join(',')}${s.error ? `, error: ${s.error}` : ''}`);
  check(`${platform}: and never asks the browser for the camera or WebXR`, !shell.cameraUsed && !shell.xrAsked,
    `camera ${shell.cameraUsed}, webxr ${shell.xrAsked}`);

  // The camera shows through the page.
  const see = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    video: getComputedStyle(document.querySelector('video.passthrough')).display,
  }));
  check(`${platform}: the page is see-through, so the app's camera shows`,
    see.html === 'rgba(0, 0, 0, 0)' && see.body === 'rgba(0, 0, 0, 0)' && see.video === 'none', JSON.stringify(see));

  // The camera follows the phone, position and all: native (x, y, z) → renderer (-x, y, z).
  await page.waitForTimeout(300);
  s = await scene(page);
  check(`${platform}: the 3D camera stands where the phone is`,
    s.camera && Math.abs(s.camera[1] - 1.4) < 1e-3 && Math.abs(s.camera[2]) < 1e-3, JSON.stringify(s.camera));

  // The floor the app found, and a tap on it.
  await page.evaluate(() => { window.__shell.floorY = 0; });
  await page.waitForTimeout(200);
  const box = await page.locator('canvas.viewer-canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await page.waitForTimeout(300);
  s = await scene(page);
  check(`${platform}: a tap places the assembly on the measured floor`,
    s.anchor && Math.abs(s.anchor[1]) < 0.02 && s.placement !== 'awaiting',
    s.anchor ? `anchor y ${s.anchor[1].toFixed(3)} (${s.placement})` : `not placed (${s.placement})`);

  // Walk a metre toward it: the camera moves, the assembly does not.
  const placedAt = s.anchor;
  await page.evaluate(() => { window.__shell.walkZ = -1; });
  await page.waitForTimeout(300);
  s = await scene(page);
  check(`${platform}: walking moves the camera and leaves the assembly where it was put`,
    s.camera && Math.abs(s.camera[2] - -1) < 1e-3 && placedAt && s.anchor
      && Math.hypot(s.anchor[0] - placedAt[0], s.anchor[1] - placedAt[1], s.anchor[2] - placedAt[2]) < 1e-6,
    `camera z ${s.camera?.[2]?.toFixed(3)}, anchor moved ${placedAt && s.anchor ? Math.hypot(s.anchor[0] - placedAt[0], s.anchor[1] - placedAt[1], s.anchor[2] - placedAt[2]).toFixed(4) : '?'} m`);

  // Recognition reads the app's camera frames.
  await page.waitForTimeout(2500);
  const images = await page.evaluate(() => window.__shell.imagesSent);
  check(`${platform}: recognition asks the app for camera frames, one at a time`, images >= 2, `${images} frames`);

  // Malformed messages are dropped, not trusted.
  await page.evaluate(() => {
    for (const junk of ['nonsense', '{"type":"pose"}', '{"type":"pose","t":1,"fovDeg":60,"tracking":"normal","pose":{"position":[0,1e9],"rotation":[0,0,0,1]}}', 42, null]) {
      window.spatialNative.receive(junk);
    }
  });
  await page.waitForTimeout(100);
  s = await scene(page);
  check(`${platform}: malformed messages from the app are ignored`, errors.length === 0 && s.source === 'native',
    errors.join(' | ') || 'no errors');

  // Exit tells the app to stop.
  await page.locator('.ar-bar .ar-btn', { hasText: 'Exit' }).click();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({ sent: window.__shell.sent, source: window.spatialStore.getState().arSource }));
  check(`${platform}: Exit stops the app's AR session`, after.sent.includes('stop') && after.source === undefined,
    after.sent.join(','));
  await context.close();
}

// --- A shell that never answers: the browser's own AR takes over. ---------------------
{
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.addInitScript(FAKE_SHELL, { platform: 'android', answer: false });
  await page.goto(`${URL}?assembly=kallax-4x2`, { waitUntil: 'networkidle' });
  await enter(page);
  await page.waitForTimeout(8000);
  const r = await page.evaluate(() => ({ sent: window.__shell.sent, camera: window.__shell.cameraUsed, source: window.spatialStore.getState().arSource }));
  check('a silent app is given up on, and the browser\'s own camera path is tried',
    r.sent.includes('start') && r.sent.includes('stop') && r.camera && r.source !== 'native',
    JSON.stringify(r));
  await context.close();
}

await browser.close();
finish('the app works inside the native shells');
