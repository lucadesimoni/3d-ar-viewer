#!/usr/bin/env node
/**
 * Zero-dependency static server for the built app — the "runnable package".
 *
 * Serves `dist/` over HTTP with correct MIME types and a single-page-app
 * fallback, so a built copy of Spatial Assembly AR runs anywhere Node runs, with
 * no extra install. AR features (camera, sensors, WebXR) need a secure context
 * on a device; pass `--https` with a cert/key, or put this behind a TLS-
 * terminating proxy or tunnel when testing on an iPad/iPhone.
 *
 *   node server/serve.mjs                 # http://0.0.0.0:8080, serves ./dist
 *   PORT=3000 node server/serve.mjs
 *   node server/serve.mjs --dir dist --https --cert cert.pem --key key.pem
 *   node server/serve.mjs --isolate       # send COOP/COEP for ONNX WASM threads
 */
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(opt('dir', process.env.SERVE_DIR ?? join(HERE, '..', 'dist')));
const PORT = Number(opt('port', process.env.PORT ?? 8080));
const HOST = opt('host', process.env.HOST ?? '0.0.0.0');
const ISOLATE = flag('isolate');

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|wasm)|image\/svg)/;
const gzipCache = new Map(); // path -> { mtimeMs, body }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.usdz': 'model/vnd.usdz+zip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Resolve a URL path to a real file inside ROOT, blocking traversal. */
async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(clean).replace(/^(\.\.[/\\])+/, '');
  let target = join(ROOT, rel);
  if (!target.startsWith(ROOT)) return undefined; // traversal attempt
  try {
    const s = await stat(target);
    if (s.isDirectory()) target = join(target, 'index.html');
    await stat(target);
    return target;
  } catch {
    return undefined;
  }
}

async function handler(req, res) {
  const urlPath = (req.url ?? '/').split('?')[0];

  // Liveness/readiness probe for orchestrators and load balancers.
  if (urlPath === '/healthz' || urlPath === '/livez') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  const isHashedAsset = urlPath.startsWith('/assets/'); // Vite fingerprints every asset here
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Grant the sensor/AR features the app needs, to itself (a host iframe still
    // has to pass them through its own allow attribute). No X-Frame-Options, so
    // the app stays embeddable.
    'Permissions-Policy': 'camera=(self), xr-spatial-tracking=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)',
    // Vite fingerprints assets, so they are safe to cache forever; HTML is not.
    'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (ISOLATE) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }

  let file = await resolveFile(urlPath);
  if (!file && !extname(urlPath)) file = await resolveFile('/index.html'); // SPA fallback
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  try {
    const info = await stat(file);
    let body = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    headers['Content-Type'] = type;

    // Gzip compressible responses when the client accepts it, cached by mtime.
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    if (acceptsGzip && COMPRESSIBLE.test(type) && body.length > 512) {
      const cached = gzipCache.get(file);
      let gz;
      if (cached && cached.mtimeMs === info.mtimeMs) gz = cached.body;
      else {
        gz = gzipSync(body);
        gzipCache.set(file, { mtimeMs: info.mtimeMs, body: gz });
      }
      body = gz;
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('500 Internal Server Error');
  }
}

async function main() {
  try {
    const s = await stat(ROOT);
    if (!s.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`\n  ✗ Build directory not found: ${ROOT}\n    Run \`npm run build\` first, or pass --dir <path>.\n`);
    process.exit(1);
  }

  let server;
  if (flag('https')) {
    const cert = opt('cert', process.env.TLS_CERT);
    const key = opt('key', process.env.TLS_KEY);
    if (!cert || !key) {
      console.error('  ✗ --https needs --cert <file> and --key <file> (or TLS_CERT/TLS_KEY).');
      process.exit(1);
    }
    server = createHttps({ cert: await readFile(cert), key: await readFile(key) }, handler);
  } else {
    server = createHttp(handler);
  }

  server.listen(PORT, HOST, () => {
    const scheme = flag('https') ? 'https' : 'http';
    console.log(`\n  Spatial Assembly AR — serving ${ROOT}`);
    console.log(`  ➜  ${scheme}://localhost:${PORT}/`);
    console.log(`  ➜  ${scheme}://${HOST}:${PORT}/  (LAN)`);
    if (scheme === 'http') console.log('  ℹ AR on a device needs HTTPS — use --https or a tunnel.\n');
    else console.log('');
  });
}

main();
