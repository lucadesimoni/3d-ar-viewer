/**
 * The third-party notices every distribution of the app must carry.
 *
 *   node scripts/third-party-notices.mjs [outDir]    # default: dist
 *
 * The app is proprietary (see LICENSE), and is compiled together with open
 * source packages whose licences (MIT, BSD, Apache-2.0, ISC) allow that on one
 * condition: their copyright and licence texts travel with every copy. So
 * every package in the production dependency tree is listed here with its
 * licence text, and the result goes into `dist` (and so into the web archive,
 * the npm package, the container image and the live site) next to the app's
 * own LICENSE. The Mendix widget packages a copy of both.
 *
 * A dependency whose licence does not allow a proprietary product (GPL,
 * AGPL, LGPL, SSPL, or none stated) stops the build rather than shipping.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Licences that allow use in a proprietary product, given their notices are kept. */
export const PERMISSIVE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Zlib', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0']);

/** A package.json's licence, as one SPDX-ish string. */
export function licenceOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return 'UNKNOWN';
}

/** Whether `licence` (an SPDX expression) leaves a proprietary product possible. */
export function allowsProprietary(licence) {
  const expr = licence.replace(/[()]/g, ' ').trim();
  if (/\bOR\b/.test(expr)) return expr.split(/\s+OR\s+/).some((part) => allowsProprietary(part));
  if (/\bAND\b/.test(expr)) return expr.split(/\s+AND\s+/).every((part) => allowsProprietary(part));
  return PERMISSIVE.has(expr);
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/**
 * Copyright holders where a package ships no licence file and its npm
 * `author` is a maintainer rather than the holder. ONNX Runtime's own
 * repository licence reads "Copyright (c) Microsoft Corporation".
 */
const HOLDERS = { 'onnxruntime-web': 'Microsoft Corporation', 'onnxruntime-common': 'Microsoft Corporation' };

/** The standard texts, for packages that declare a licence but ship no file of it. */
const STANDARD = {
  MIT: (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  ISC: (holder) => `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
};

function holderOf(pkg) {
  if (HOLDERS[pkg.name]) return HOLDERS[pkg.name];
  const a = pkg.author;
  if (typeof a === 'string' && a.trim()) return a.replace(/\s*[<(].*$/, '').trim();
  if (a?.name) return a.name;
  return `the authors of ${pkg.name}`;
}

/** The notice for one package: name, licence and every licence/notice file it ships. */
export function noticeFor(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const texts = readdirSync(dir).filter((f) => LICENCE_FILE.test(f)).sort()
    .map((f) => readFileSync(join(dir, f), 'utf8').trim());
  return {
    name: pkg.name,
    version: pkg.version,
    licence: licenceOf(pkg),
    text: texts.join('\n\n')
      || STANDARD[licenceOf(pkg)]?.(holderOf(pkg))
      || `${licenceOf(pkg)} (no licence file included in the package)`,
  };
}

export function renderNotices(notices) {
  const head = [
    'Spatial Assembly AR includes the following third-party software.',
    'Each component is licensed under its own terms, reproduced below; those',
    'terms apply to that component and are not changed by the licence of',
    'Spatial Assembly AR itself (see LICENSE).',
    '',
  ];
  const body = notices.map((n) => [
    '='.repeat(78),
    `${n.name} ${n.version} — ${n.licence}`,
    '='.repeat(78),
    n.text,
    '',
  ].join('\n'));
  return `${head.join('\n')}\n${body.join('\n')}`;
}

function productionPackages() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: ROOT, encoding: 'utf8' });
  const dirs = out.trim().split('\n').slice(1).filter((d) => existsSync(join(d, 'package.json')));
  const seen = new Map();
  for (const d of dirs) {
    const n = noticeFor(d);
    seen.set(`${n.name}@${n.version}`, n);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const outDir = resolve(ROOT, process.argv[2] ?? 'dist');
  const notices = productionPackages();
  const refused = notices.filter((n) => !allowsProprietary(n.licence));
  if (refused.length) {
    throw new Error(`these dependencies' licences do not allow a proprietary product: ${
      refused.map((n) => `${n.name}@${n.version} (${n.licence})`).join(', ')}`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), renderNotices(notices));
  copyFileSync(join(ROOT, 'LICENSE'), join(outDir, 'LICENSE.txt'));
  console.log(`third-party notices: ${notices.length} packages → ${join(outDir, 'THIRD_PARTY_NOTICES.txt')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message ?? error); process.exit(1); }
}
