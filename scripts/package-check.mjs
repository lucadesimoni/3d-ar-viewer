/**
 * Try each release asset the way someone receiving it would.
 *
 *   npm run release:package && npm run release:check
 *
 * A package that was built is not yet a package that works. Each check here
 * does what its user does with it:
 *
 *  - the checksums are checked against the files;
 *  - the web archives are unpacked, and hold the whole app;
 *  - the npm package is installed globally into a scratch prefix, with no
 *    network, and its `spatial-ar-viewer` command started and asked for the app;
 *  - the Mendix `.mpk` is unzipped and its `package.xml` followed to files that
 *    exist, then its widget is loaded into a host page twice, the way the Mendix
 *    client loads one (an AMD loader for `.js`, ES modules for `.mjs`), each
 *    time with React supplied by the host, and rendered. It must draw its 3D
 *    view, throw nothing, and leave the host page's own styles alone.
 *
 * What it cannot do is load the widget into Mendix Studio Pro itself, and the
 * host React here is this repository's (19); Mendix 10 ships 18.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createChecks } from './checks.mjs';
import { assetNames, OUT } from './package.mjs';
import { launchOptions } from './chrome.mjs';

const ROOT = resolve(OUT, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const owner = (process.env.GITHUB_REPOSITORY_OWNER || 'lucadesimoni').toLowerCase();
const names = assetNames(version, owner);
const { check, finish } = createChecks('package-check');
const scratch = mkdtempSync(join(tmpdir(), 'spatial-ar-release-'));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

function freePort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

async function waitFor(url, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}

/** Start the repository's own server on `dir`, the way the npm package's command does. */
async function serve(command, args, env = {}) {
  const port = await freePort();
  const child = spawn(command, args, { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: 'ignore' });
  return { child, base: `http://127.0.0.1:${port}/` };
}

// --- Checksums. ---------------------------------------------------------------
{
  const lines = readFileSync(join(OUT, names.sums), 'utf8').trim().split('\n');
  const listed = new Map(lines.map((l) => { const [sum, file] = l.split(/\s+/); return [file, sum]; }));
  const bad = [...listed].filter(([file, sum]) =>
    createHash('sha256').update(readFileSync(join(OUT, file))).digest('hex') !== sum);
  check('every asset matches its checksum', bad.length === 0 && listed.size >= 4,
    bad.length ? `mismatch: ${bad.map(([f]) => f).join(', ')}` : `${listed.size} assets`);
  check('and every asset is listed', [names.webZip, names.webTar, names.npm, names.mpk].every((f) => listed.has(f)));
}

// --- The web app archives. ------------------------------------------------------
{
  const zipFiles = sh('unzip', ['-Z1', join(OUT, names.webZip)]).trim().split('\n').filter((f) => !f.endsWith('/'));
  const tarFiles = sh('tar', ['-tzf', join(OUT, names.webTar)]).trim().split('\n')
    .filter((f) => !f.endsWith('/')).map((f) => f.replace(/^\.\//, ''));
  const need = ['index.html', 'xr-check.html', 'sw.js', 'manifest.webmanifest', 'embed-demo.html'];
  check('the web zip holds the whole app', need.every((f) => zipFiles.includes(f)) && zipFiles.some((f) => /^assets\/index-.*\.js$/.test(f)),
    `${zipFiles.length} files`);
  check('and the tarball holds the same files', JSON.stringify([...zipFiles].sort()) === JSON.stringify([...tarFiles].sort()),
    `${tarFiles.length} files`);
}

// --- The server, installed from its npm package. ------------------------------------
{
  const listing = sh('tar', ['-tzf', join(OUT, names.npm)]).split('\n');
  const manifest = JSON.parse(sh('tar', ['-xzOf', join(OUT, names.npm), 'package/package.json']));
  check('the npm package holds the app and the server',
    ['package/server/serve.mjs', 'package/dist/index.html', 'package/LICENSE'].every((f) => listing.includes(f)));
  check('and depends on nothing, so installing it fetches nothing',
    !manifest.dependencies && !manifest.devDependencies && manifest.version === version,
    `${manifest.name}@${manifest.version}`);

  const prefix = join(scratch, 'npm-global');
  let installed = false;
  try {
    sh('npm', ['install', '--global', '--offline', '--no-audit', '--no-fund', '--prefix', prefix, join(OUT, names.npm)]);
    installed = existsSync(join(prefix, 'bin', 'spatial-ar-viewer'));
  } catch (error) {
    check('it installs with no network', false, String(error.message ?? error).split('\n')[0]);
  }
  if (installed) {
    check('it installs with no network, and puts spatial-ar-viewer on the path', true);
    const { child, base } = await serve(join(prefix, 'bin', 'spatial-ar-viewer'), []);
    try {
      const health = await waitFor(`${base}healthz`);
      check('the installed command serves the app', Boolean(health), base);
      const html = health ? await (await fetch(base)).text() : '';
      const script = html.match(/src="\/?(assets\/index-[^"]+\.js)"/)?.[1];
      const js = script ? await fetch(`${base}${script}`) : undefined;
      check('with its scripts', Boolean(js?.ok), script ?? 'no entry script in index.html');
    } finally {
      child.kill();
    }
  }
}

// --- The Mendix widget. ---------------------------------------------------------------
const widgetDir = join(scratch, 'mpk');
{
  sh('unzip', ['-q', join(OUT, names.mpk), '-d', widgetDir]);
  const files = sh('unzip', ['-Z1', join(OUT, names.mpk)]).trim().split('\n').filter((f) => !f.endsWith('/'));
  const packageXml = readFileSync(join(widgetDir, 'package.xml'), 'utf8');
  const widgetFile = packageXml.match(/<widgetFile path="([^"]+)"/)?.[1];
  const folder = packageXml.match(/<file path="([^"]+)"/)?.[1];
  const declared = packageXml.match(/<clientModule\b[^>]*\bversion="([^"]+)"/)?.[1];
  check('the .mpk\'s package.xml names its widget file, and it is there',
    Boolean(widgetFile) && files.includes(widgetFile), widgetFile);
  check('and carries this release\'s version', declared === version, `${declared}`);
  const widgetXml = widgetFile ? readFileSync(join(widgetDir, widgetFile), 'utf8') : '';
  const id = widgetXml.match(/<widget\s[^>]*\bid="([^"]+)"/)?.[1] ?? '';
  // Mendix finds a widget's code from its id: org.widgetname.Name lives in
  // org/widgetname/Name.js. The folder package.xml lists has to be that one.
  const expected = id.split('.').slice(0, -1).join('/');
  const name = id.split('.').pop();
  check('the widget id resolves to the folder package.xml lists',
    Boolean(id) && folder === expected, `${id} → ${expected}, listed ${folder}`);
  check('and both builds are in it', [`${expected}/${name}.js`, `${expected}/${name}.mjs`].every((f) => files.includes(f)));
}

// The host page. React comes from the host, as it does in Mendix; built here
// from this repository's React into one script that sets `window.__host`.
const hostDir = join(scratch, 'host');
{
  const { build } = await import('vite');
  const entry = join(scratch, 'host-entry.mjs');
  writeFileSync(entry, [
    `import * as React from '${join(ROOT, 'node_modules/react/index.js')}';`,
    `import * as ReactDOM from '${join(ROOT, 'node_modules/react-dom/index.js')}';`,
    `import * as JSX from '${join(ROOT, 'node_modules/react/jsx-runtime.js')}';`,
    `import { createRoot } from '${join(ROOT, 'node_modules/react-dom/client.js')}';`,
    'window.__host = { React, ReactDOM, JSX, createRoot };',
  ].join('\n'));
  await build({
    configFile: false, logLevel: 'silent', root: scratch,
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: hostDir, emptyOutDir: true, lib: { entry, formats: ['iife'], name: 'Host', fileName: () => 'host.js' } },
  });
  cpSync(widgetDir, join(hostDir, 'widget'), { recursive: true });
  const shared = `
    <style>button { background: rgb(1, 2, 3); } h2 { color: rgb(4, 5, 6); }</style>
    <button id="host-button">A host button</button><h2 id="host-heading">A host heading</h2>
    <div id="mount" style="width: 900px; height: 640px"></div>
    <script src="host.js"></script>`;
  const render = `
    const { React, createRoot } = window.__host;
    createRoot(document.getElementById('mount')).render(React.createElement(widget.SpatialArViewer, {
      uiPreset: { value: 'viewer' }, embedded: { value: true },
    }));`;
  writeFileSync(join(hostDir, 'amd.html'), `<!doctype html><meta charset="utf-8">${shared}
    <script>
      // The AMD contract the Mendix client keeps: define(deps, factory), with
      // React supplied by the host and nothing fetched for it.
      window.define = (deps, factory) => {
        const exports = {};
        const host = { react: __host.React, 'react-dom': __host.ReactDOM, 'react/jsx-runtime': __host.JSX };
        factory(...deps.map((d) => (d === 'exports' ? exports : host[d])));
        window.__widget = exports;
      };
      window.define.amd = {};
    </script>
    <script src="widget/anthropic/spatialarviewer/SpatialArViewer.js"></script>
    <script>const widget = window.__widget; ${render}</script>`);
  const reexport = (expr, keys) => `data:text/javascript,${encodeURIComponent(
    `const m = ${expr}; export default m; export const { ${keys.join(', ')} } = m;`)}`;
  // The module names the widget imports, mapped onto the host's React.
  const reactKeys = Object.keys(await import('react')).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
  const jsxKeys = Object.keys(await import('react/jsx-runtime')).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
  const domKeys = Object.keys(await import('react-dom')).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
  writeFileSync(join(hostDir, 'esm.html'), `<!doctype html><meta charset="utf-8">${shared}
    <script type="importmap">${JSON.stringify({ imports: {
      react: reexport('window.__host.React', reactKeys),
      'react/jsx-runtime': reexport('window.__host.JSX', jsxKeys),
      'react-dom': reexport('window.__host.ReactDOM', domKeys),
    } })}</script>
    <script type="module">
      const widget = await import('./widget/anthropic/spatialarviewer/SpatialArViewer.mjs');
      ${render}
    </script>`);
}

{
  const { chromium } = await import('playwright');
  const browser = await chromium.launch(launchOptions());
  const { child, base } = await serve('node', [join(ROOT, 'server/serve.mjs'), '--dir', hostDir]);
  try {
    if (!(await waitFor(`${base}healthz`))) throw new Error('could not serve the widget host page');
    for (const [label, page] of [['AMD (.js)', 'amd.html'], ['ES module (.mjs)', 'esm.html']]) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      const tab = await context.newPage();
      const errors = [];
      tab.on('pageerror', (e) => errors.push(String(e.message ?? e)));
      await tab.goto(`${base}${page}`);
      const drawn = await tab.waitForSelector('#mount canvas.viewer-canvas', { timeout: 20000 }).then(() => true, () => false);
      check(`Mendix widget, ${label}: renders its 3D view in a host page`, drawn);
      check(`Mendix widget, ${label}: throws nothing`, errors.length === 0, errors.slice(0, 2).join(' | '));
      const styles = await tab.evaluate(() => {
        const css = (el, p) => (el ? getComputedStyle(el)[p] : null);
        const root = document.querySelector('#mount .spatial-ar-widget');
        const own = document.querySelector('#mount .spatial-ar-widget button');
        return {
          hostButton: css(document.getElementById('host-button'), 'backgroundColor'),
          hostButtonRadius: css(document.getElementById('host-button'), 'borderRadius'),
          hostHeading: css(document.getElementById('host-heading'), 'color'),
          hostBody: css(document.body, 'backgroundColor'),
          hostAccent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          ownAccent: root ? getComputedStyle(root).getPropertyValue('--accent').trim() : '',
          ownButtonRadius: css(own, 'borderRadius'),
        };
      });
      check(`Mendix widget, ${label}: leaves the host page's own styles alone`,
        styles.hostButton === 'rgb(1, 2, 3)' && styles.hostHeading === 'rgb(4, 5, 6)'
          && styles.hostBody === 'rgba(0, 0, 0, 0)' && styles.hostAccent === '' && styles.hostButtonRadius === '0px',
        JSON.stringify(styles));
      // The app's theme (its :root, moved onto the widget) and its base button
      // rule both reach the widget, and only the widget.
      check(`Mendix widget, ${label}: and styles its own`,
        styles.ownAccent !== '' && styles.ownButtonRadius === '10px',
        `--accent ${styles.ownAccent || 'unset'}, button radius ${styles.ownButtonRadius}`);
      await context.close();
    }
  } finally {
    child.kill();
    await browser.close();
  }
}

rmSync(scratch, { recursive: true, force: true });
finish(`release ${version}: every asset works the way it will be used`);
