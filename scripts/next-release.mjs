/**
 * Prepare the next release from what was merged since the last one.
 *
 *   node scripts/next-release.mjs [--bump=patch|minor|major]
 *
 * Run by `.github/workflows/auto-release.yml` whenever CI passes on `main`:
 *
 *  - the next version is the latest `vX.Y.Z` tag, bumped. Patch by default;
 *    a merge whose message says `[minor]` or `[major]` (or `BREAKING CHANGE`)
 *    raises it, and `--bump` sets the least it may be;
 *  - the notes are the merges since that tag, one line each, written into
 *    `CHANGELOG.md` as the new version's section, unless a hand-written
 *    `## [Unreleased]` section is there: that is released as written;
 *  - `package.json` and `package-lock.json` take the new version.
 *
 * Writes `version=` and `release=true|false` to `$GITHUB_OUTPUT` when there is
 * one. With nothing merged since the last tag it changes nothing and says
 * `release=false`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = ['patch', 'minor', 'major'];

/** `1.2.3` bumped by `level`. */
export function nextVersion(current, level) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`not a plain x.y.z version: "${current}"`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump "${level}"`);
}

/** The largest bump any message asks for, and never less than `floor`. */
export function bumpLevel(messages, floor = 'patch') {
  let level = LEVELS.indexOf(floor);
  if (level < 0) throw new Error(`unknown bump "${floor}"`);
  for (const m of messages) {
    if (/\[major\]|BREAKING CHANGE/.test(m)) level = Math.max(level, 2);
    else if (/\[minor\]/.test(m)) level = Math.max(level, 1);
  }
  return LEVELS[level];
}

/**
 * One line per change from the subjects of the commits merged since the last
 * release: "Merge: " dropped, release commits and repeats left out, markers
 * removed.
 */
export function releaseEntries(subjects) {
  const seen = new Set();
  const out = [];
  for (const raw of subjects) {
    const s = raw.trim();
    if (!s || /^Release v\d+\.\d+\.\d+/.test(s)) continue;
    const bare = s.replace(/^Merge:\s*/, '').replace(/\s*\[(major|minor)\]\s*/g, ' ').trim();
    const entry = bare.charAt(0).toUpperCase() + bare.slice(1);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

export function changelogSection(version, date, entries) {
  return [`## [${version}] — ${date}`, '', ...entries.map((e) => `- ${e}`), ''].join('\n');
}

/**
 * A hand-written `## [Unreleased]` section, released as this version: the
 * notes as written, in place of the list of merges. Undefined when there is
 * none, or it is empty (then it is dropped and the list is used).
 */
export function releaseUnreleased(changelog, version, date) {
  const lines = changelog.split('\n');
  const at = lines.findIndex((l) => /^## \[?Unreleased\]?\s*$/i.test(l));
  if (at < 0) return undefined;
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end < 0) end = lines.length;
  if (!lines.slice(at + 1, end).join('\n').trim()) return undefined;
  lines[at] = `## [${version}] — ${date}`;
  return lines.join('\n');
}

/** Without an empty `## [Unreleased]` heading, so it does not sit above the release. */
export function dropEmptyUnreleased(changelog) {
  const lines = changelog.split('\n');
  const at = lines.findIndex((l) => /^## \[?Unreleased\]?\s*$/i.test(l));
  if (at < 0) return changelog;
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end < 0) end = lines.length;
  if (lines.slice(at + 1, end).join('\n').trim()) return changelog;
  return [...lines.slice(0, at), ...lines.slice(end)].join('\n');
}

/** `section` placed above the newest existing version, below the preamble. */
export function insertSection(changelog, section) {
  const lines = changelog.split('\n');
  const at = lines.findIndex((l) => /^## /.test(l));
  if (at < 0) return `${changelog.trimEnd()}\n\n${section}`;
  return [...lines.slice(0, at), ...section.trimEnd().split('\n'), '', ...lines.slice(at)].join('\n');
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function output(pairs) {
  const text = Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('\n');
  console.log(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
}

function main() {
  const floor = process.argv.find((a) => a.startsWith('--bump='))?.slice(7) ?? 'patch';
  const tags = git('tag', '--list', 'v*.*.*', '--sort=-v:refname').split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const last = tags[0];
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  // The merges on main since the last release: first parent only, so each
  // merge is one entry and the commits inside it are not repeated.
  const range = last ? [`${last}..HEAD`] : ['HEAD'];
  const log = git('log', '--first-parent', '--format=%s%x1f%b%x1e', ...range);
  const commits = log.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => {
    const [subject, body = ''] = c.split('\x1f');
    return { subject, body };
  });
  const entries = releaseEntries(commits.map((c) => c.subject));
  if (entries.length === 0) {
    console.log(`nothing merged since ${last ?? 'the start'}`);
    output({ release: 'false' });
    return;
  }
  const level = bumpLevel(commits.map((c) => `${c.subject}\n${c.body}`), floor);
  const base = last ? last.slice(1) : pkg.version;
  const version = last ? nextVersion(base, level) : pkg.version;

  const date = new Date().toISOString().slice(0, 10);
  const changelogPath = join(ROOT, 'CHANGELOG.md');
  const current = readFileSync(changelogPath, 'utf8');
  // Notes written by hand for this release win over the list of merges.
  const written = releaseUnreleased(current, version, date);
  writeFileSync(changelogPath,
    written ?? insertSection(dropEmptyUnreleased(current), changelogSection(version, date, entries)));
  execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: ROOT, stdio: 'ignore' });

  console.log(`${last ?? '(none)'} → v${version} (${level}), ${entries.length} change(s)`);
  output({ release: 'true', version });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message ?? error); process.exit(1); }
}
