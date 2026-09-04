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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': req.url === '/' ? 'no-cache' : 'public, max-age=3600',
  };
  // Cross-origin isolation unlocks multi-threaded WASM (faster ONNX), but
  // COEP can block cross-origin CDN assets — opt-in only.
  if (ISOLATE) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }

  let file = await resolveFile(req.url ?? '/');
  // SPA fallback: unknown non-asset paths serve index.html.
  if (!file && !extname(req.url ?? '')) file = await resolveFile('/index.html');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  try {
    const body = await readFile(file);
    headers['Content-Type'] = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
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
