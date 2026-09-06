/**
 * Service worker — offline-capable app shell for shop-floor tablets.
 *
 * The routing is split by what can go stale, which is the whole game when the
 * app is redeployed behind a stable URL:
 *
 *   /assets/*  Vite fingerprints these, so the name changes whenever the bytes
 *              do. Cache-first, forever, no revalidation — this is where the
 *              offline speed comes from.
 *   everything Network-first with a short timeout, falling back to cache. The
 *   else       HTML shell lives here, and it must never be served stale: it
 *              names the fingerprinted bundles, so a cached copy from an older
 *              deployment points at asset URLs that no longer exist. That is a
 *              blank screen, not a stale screen.
 *
 * Cross-origin requests (the OpenCV / ONNX CDN bundles) are left to the network
 * and degrade to nothing when offline — the geometry-driven app still runs.
 */
const CACHE = 'spatial-ar-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];
/** How long a navigation waits for the network before using the cached shell. */
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

/**
 * Cache the shell *and the bundles it names*, at install.
 *
 * The obvious version — cache the shell, let the fetch handler pick up assets as
 * they are requested — leaves a first-time visitor with an uncacheable app: on
 * the first load the worker is not controlling the page yet, so every bundle
 * request bypasses it, and the first time the tablet is offline there is an
 * index.html in the cache pointing at scripts that were never stored. It looks
 * like it works, right up until the moment it has to.
 *
 * The fingerprinted names are not knowable when this file is written, so they
 * are read out of the freshly fetched index.html — which is by definition the
 * list of what this deployment needs to start.
 */
async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.allSettled(SHELL.map((url) => cache.add(url)));
  try {
    const html = await (await fetch('/index.html', { cache: 'no-store' })).text();
    const assets = [...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map((m) => m[0]);
    await Promise.allSettled([...new Set(assets)].map((url) => cache.add(url)));
  } catch (err) {
    // Offline at install time: the shell is cached, the bundles will be picked
    // up by the fetch handler on the first online visit.
  }
}

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(url.pathname.startsWith('/assets/') ? cacheFirst(req) : networkFirst(req));
});

/** Fingerprinted asset: if it is in the cache it is by definition current. */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return Response.error();
  }
}

/** Fresh if the network answers in time, cached if it does not. */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    return Response.error();
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
