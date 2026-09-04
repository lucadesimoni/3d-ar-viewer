/**
 * Service worker — offline-capable app shell for shop-floor tablets.
 *
 * Same-origin GET requests use stale-while-revalidate: serve the cached copy
 * instantly (works with no network), and refresh it in the background when
 * online. Navigations fall back to the cached index so the SPA opens offline.
 * Cross-origin requests (the OpenCV / ONNX CDN bundles) are left to the network
 * and simply degrade when offline — the geometry-driven app still runs.
 */
const CACHE = 'spatial-ar-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached || (req.mode === 'navigate' ? cache.match('/index.html') : undefined));
      return cached || network;
    }),
  );
});
