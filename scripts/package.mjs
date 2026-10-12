/**
 * Build every release asset into `release/`.
 *
 *   npm run release:package                 # build the app, then package it all
 *   npm run release:package -- --skip-build # package the `dist` already built
 *
 * One component, one asset, all from the same build:
 *
 *  - the web app: `dist` as `.zip` and `.tar.gz`, for any static host;
 *  - the server: an npm package holding `dist` and `server/serve.mjs`, with the
 *    `spatial-ar-viewer` command. No dependencies: the app's are compiled into
 *    `dist`, and the server is written to need none. Private: never published;
 *  - every one of them with LICENSE.txt and THIRD_PARTY_NOTICES.txt, which the
 *    build puts into `dist` (`scripts/third-party-notices.mjs`);
 *  - the Mendix widget: an `.mpk` (`vite.widget.config.ts`);
 *  - `SHA256SUMS.txt` over all of them, and `RELEASE_NOTES.md` cut from
 *    `CHANGELOG.md`.
 *
 * The container image is built from the `Dockerfile` by the release workflow
 * (`.github/workflows/release.yml`); `scripts/package-check.mjs` tries each of
 * the assets here the way someone receiving it would.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
export const OUT = join(ROOT, 'release');

/** What each asset of version `v` is called. */
export function assetNames(version, owner = 'lucadesimoni') {
  return {
    webZip: `spatial-ar-web-${version}.zip`,
    webTar: `spatial-ar-web-${version}.tar.gz`,
    npm: `${owner}-spatial-ar-viewer-${version}.tgz`,
    mpk: `anthropic.SpatialArViewer-${version}.mpk`,
    imageAmd64: `spatial-ar-image-${version}-amd64.tar.gz`,
    imageArm64: `spatial-ar-image-${version}-arm64.tar.gz`,
    sums: 'SHA256SUMS.txt',
    notes: 'RELEASE_NOTES.md',
  };
}

/**
 * The server package's manifest: the root one, less everything it does not
 * need. Private: it is a release asset for licensees, and `npm publish`
 * refuses a private package, so it cannot reach a registry by accident.
 */
export function stagedPackageJson(pkg, owner = 'lucadesimoni') {
  return {
    name: `@${owner}/spatial-ar-viewer`,
    version: pkg.version,
    description: 'Spatial Assembly AR: the built web app and the zero-dependency server that hosts it.',
    license: pkg.license,
    type: 'module',
    engines: pkg.engines,
    bin: { 'spatial-ar-viewer': 'server/serve.mjs' },
    files: ['dist', 'server', 'README.md', 'COMPLIANCE.md', 'LICENSE'],
    repository: { type: 'git', url: `git+https://github.com/${owner}/3d-ar-viewer.git` },
    private: true,
  };
}

/** `src/mendix/package.xml` with the release's version in it. */
export function packageXmlFor(template, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Mendix needs a plain x.y.z version, not "${version}"`);
  const out = template.replace(/(<clientModule\b[^>]*\bversion=")[^"]*(")/, `$1${version}$2`);
  if (out === template && !template.includes(`version="${version}"`)) throw new Error('package.xml has no clientModule version to set');
  return out;
}

/** How to get each component, appended to the release's notes. */
export function installNotes(version, owner = 'lucadesimoni') {
  const n = assetNames(version, owner);
  return [
    '### Install',
    '',
    `- **Web app**: unpack \`${n.webZip}\` (or \`${n.webTar}\`) onto any static host. AR needs HTTPS.`,
    `- **Server**: \`npm install -g ./${n.npm}\`, then \`spatial-ar-viewer\` (port 8080; \`--https\` with a certificate for devices).`,
    `- **Container**: \`docker load -i ${n.imageAmd64}\` (or \`${n.imageArm64}\`), then \`docker run -p 8080:8080 spatial-ar:${version}\`.`,
    `- **Mendix widget**: import \`${n.mpk}\` into the app's \`widgets\` folder (Studio Pro: App → Synchronize App Directory).`,
    '',
    `Check downloads against \`${n.sums}\`: \`sha256sum -c ${n.sums}\`.`,
    '',
    'Proprietary software of Outthinkx, licensed for evaluation only: see LICENSE.txt in each package.',
    'Third-party components keep their own licences: THIRD_PARTY_NOTICES.txt.',
    '',
  ].join('\n');
}

/**
 * This version's section of `CHANGELOG.md`, without its heading. A release
 * whose notes are missing is a mistake to stop at, not to ship.
 */
export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n');
  const heading = new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md's section for ${version} is empty`);
  return `${body}\n`;
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts, env: { ...process.env, ...opts.env } });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const skipBuild = process.argv.includes('--skip-build');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const owner = (process.env.GITHUB_REPOSITORY_OWNER || 'lucadesimoni').toLowerCase();
  const names = assetNames(version, owner);
  const notes = releaseNotes(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  let commit = process.env.BUILD_COMMIT;
  if (!commit) {
    try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); }
    catch { commit = 'unknown'; }
  }
  const env = { BUILD_COMMIT: commit };

  rmSync(OUT, { recursive: true, force: true });
  const stage = join(OUT, '.stage');
  mkdirSync(stage, { recursive: true });

  // The app, once: every asset below is this same build.
  if (!skipBuild) run('npm', ['run', 'build'], { env });
  const dist = join(ROOT, 'dist');
  if (!existsSync(join(dist, 'index.html'))) throw new Error('no dist/index.html: build first, or drop --skip-build');
  for (const f of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']) {
    if (!existsSync(join(dist, f))) throw new Error(`no dist/${f}: the build writes it (scripts/third-party-notices.mjs)`);
  }

  // 1. The web app, for any static host.
  run('tar', ['-czf', join(OUT, names.webTar), '-C', dist, '.']);
  run('zip', ['-q', '-r', '-X', join(OUT, names.webZip), '.'], { cwd: dist });

  // 2. The server, as an npm package.
  const npmStage = join(stage, 'npm');
  mkdirSync(npmStage, { recursive: true });
  for (const f of ['dist', 'server', 'README.md', 'COMPLIANCE.md', 'LICENSE']) {
    cpSync(join(ROOT, f), join(npmStage, f), { recursive: true });
  }
  writeFileSync(join(npmStage, 'package.json'), `${JSON.stringify(stagedPackageJson(pkg, owner), null, 2)}\n`);
  run('npm', ['pack', '--silent', '--pack-destination', OUT], { cwd: npmStage });

  // 3. The Mendix widget.
  const widgetStage = join(stage, 'widget');
  run('npx', ['vite', 'build', '-c', 'vite.widget.config.ts', '--logLevel', 'warn'], { env: { ...env, WIDGET_OUT: widgetStage } });
  writeFileSync(join(widgetStage, 'package.xml'),
    packageXmlFor(readFileSync(join(ROOT, 'src/mendix/package.xml'), 'utf8'), version));
  cpSync(join(ROOT, 'src/mendix/SpatialArViewer.xml'), join(widgetStage, 'SpatialArViewer.xml'));
  // The licence and the third-party notices go with the widget's own files:
  // the folder package.xml lists is what Mendix deploys.
  for (const f of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']) {
    cpSync(join(dist, f), join(widgetStage, 'anthropic/spatialarviewer', f));
  }
  run('zip', ['-q', '-r', '-X', join(OUT, names.mpk), 'package.xml', 'SpatialArViewer.xml', 'anthropic'], { cwd: widgetStage });

  rmSync(stage, { recursive: true, force: true });

  // 4. Notes and checksums.
  writeFileSync(join(OUT, names.notes), `${notes}\n${installNotes(version, owner)}`);
  const assets = readdirSync(OUT).filter((f) => f !== names.sums && f !== names.notes).sort();
  for (const want of [names.webZip, names.webTar, names.npm, names.mpk]) {
    if (!assets.includes(want)) throw new Error(`expected ${want} in release/, found ${assets.join(', ')}`);
  }
  const sums = [];
  for (const f of assets) sums.push(`${await sha256(join(OUT, f))}  ${f}`);
  writeFileSync(join(OUT, names.sums), `${sums.join('\n')}\n`);

  console.log(`\nrelease ${version} (${commit}) in release/:`);
  for (const f of readdirSync(OUT).sort()) console.log(`  ${f}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\n${error.message ?? error}`); process.exit(1); });
}
