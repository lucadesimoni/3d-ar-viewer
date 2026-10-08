/**
 * Run the browser check suites as one battery, and say plainly what happened.
 *
 *   npm run check:all                      # every suite, serving dist if needed
 *   npm run check:all -- --only=ar-verify,steps-check
 *   npm run check:all -- --write-baseline  # after deliberately adding/removing checks
 *
 * What it adds over running the suites one by one:
 *  - every suite runs even when an earlier one fails. On CI each suite was its
 *    own step, so a failing `ar-verify` stopped the six behind it from running
 *    at all, and a week of red builds said nothing about any of them;
 *  - each suite's full output goes to `check-results/<suite>.log`; the
 *    console gets only what needs reading — failures, crashes, the summary;
 *  - check names are compared with `scripts/check-baseline.json`. A check that
 *    stops being reported is a failure: a suite that quietly skips half its
 *    checks (an early `return`, a selector that matches nothing so a loop runs
 *    zero times) otherwise looks exactly like a suite that passed;
 *  - with `--serve`, it starts `vite preview` itself when nothing is serving
 *    `PREVIEW_URL`, and stops it afterwards.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIEW_URL } from './checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/** The order CI has always used: cheapest to diagnose last. */
export const SUITES = ['ar-verify', 'steps-check', 'layout-check', 'place-check', 'notes-check', 'log-check', 'deploy-check'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

// `--dir` points at other suites — this runner's own tests use it.
const suiteDir = option('dir') ? resolve(option('dir')) : HERE;
const only = option('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const unknown = only?.filter((s) => !existsSync(join(suiteDir, `${s}.mjs`))) ?? [];
if (unknown.length) {
  console.error(`unknown suite(s): ${unknown.join(', ')} — known: ${SUITES.join(', ')}`);
  process.exit(2);
}
const suites = only ?? SUITES;
const outDir = resolve(ROOT, option('out') ?? 'check-results');
const baselinePath = resolve(ROOT, option('baseline') ?? 'scripts/check-baseline.json');
const resultsPath = join(outDir, 'results.jsonl');
const onCi = process.env.GITHUB_ACTIONS === 'true';

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start `vite preview` for a local PREVIEW_URL that nothing is serving yet. */
async function serveIfNeeded() {
  const needsApp = !option('dir') && suites.some((s) => s !== 'deploy-check');
  if (!needsApp || await reachable(PREVIEW_URL)) return undefined;
  const url = new URL(PREVIEW_URL);
  if (!flag('serve') || !['localhost', '127.0.0.1'].includes(url.hostname)) {
    console.error(`nothing is serving ${PREVIEW_URL} — start it, or pass --serve to have this do it`);
    process.exit(2);
  }
  if (!existsSync(join(ROOT, 'dist/index.html'))) {
    console.error('no build to serve — run `npm run build` first');
    process.exit(2);
  }
  const server = spawn('npx', ['vite', 'preview', '--port', url.port || '4173', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', detached: true,
  });
  for (let i = 0; i < 60 && !await reachable(PREVIEW_URL); i++) await new Promise((r) => setTimeout(r, 500));
  if (!await reachable(PREVIEW_URL)) {
    process.kill(-server.pid);
    console.error(`started vite preview, but ${PREVIEW_URL} never answered`);
    process.exit(2);
  }
  console.log(`serving dist at ${PREVIEW_URL}`);
  return server;
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = createWriteStream(join(outDir, `${suite}.log`));
    const child = spawn(process.execPath, [join(suiteDir, `${suite}.mjs`)], {
      cwd: ROOT,
      env: { ...process.env, PREVIEW_URL, CHECKS_JSON: resultsPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const echo = (chunk) => {
      log.write(chunk);
      for (const line of String(chunk).split('\n')) {
        // The lines worth reading as they happen; everything is in the log.
        if (/^(FAIL|CRASH) /.test(line)) console.log(`  ${suite}: ${line}`);
        // Annotations must reach the runner's own output to become annotations.
        else if (onCi && line.startsWith('::error')) console.log(line);
      }
    };
    child.stdout.on('data', echo);
    child.stderr.on('data', echo);
    child.on('close', (code) => {
      log.end();
      resolve({ suite, code: code ?? 1, seconds: (Date.now() - started) / 1000 });
    });
  });
}

function readResults() {
  if (!existsSync(resultsPath)) return [];
  return readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Check names per suite, sorted and de-duplicated: what a baseline holds. */
function namesBySuite(records) {
  const out = {};
  for (const r of records) {
    if (r.name === undefined) continue;
    (out[r.suite] ??= new Set()).add(r.name);
  }
  return Object.fromEntries(Object.entries(out).map(([s, n]) => [s, [...n].sort()]));
}

mkdirSync(outDir, { recursive: true });
rmSync(resultsPath, { force: true });
const server = await serveIfNeeded();
const runs = [];
try {
  for (const suite of suites) {
    console.log(`▶ ${suite}`);
    runs.push(await runSuite(suite));
  }
} finally {
  if (server) process.kill(-server.pid);
}

const records = readResults();
const names = namesBySuite(records);
const rows = runs.map(({ suite, code, seconds }) => {
  const mine = records.filter((r) => r.suite === suite && r.name !== undefined);
  return {
    suite,
    passed: mine.filter((r) => r.ok).length,
    failed: mine.filter((r) => !r.ok).length,
    crashed: records.some((r) => r.suite === suite && r.crashed),
    code,
    seconds,
  };
});

// A check that used to be reported and is not any more.
// `--no-baseline` for a run against a deployment, which may be older than
// the checks: there a missing check says the site lags, not that one was lost.
const baseline = !flag('no-baseline') && existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8')) : undefined;
const dropped = [];
const added = [];
if (baseline) {
  for (const suite of suites) {
    const before = new Set(baseline[suite] ?? []);
    const now = new Set(names[suite] ?? []);
    for (const n of before) if (!now.has(n)) dropped.push({ suite, name: n });
    for (const n of now) if (!before.has(n)) added.push({ suite, name: n });
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('suite', 14)}${pad('passed', 8)}${pad('failed', 8)}${pad('time', 8)}status`);
for (const r of rows) {
  const status = r.crashed ? 'CRASHED' : r.code === 0 ? 'ok' : `exit ${r.code}`;
  console.log(`${pad(r.suite, 14)}${pad(r.passed, 8)}${pad(r.failed, 8)}${pad(`${Math.round(r.seconds)}s`, 8)}${status}`);
}
const total = rows.reduce((n, r) => n + r.passed, 0);
const failed = rows.reduce((n, r) => n + r.failed, 0);
console.log(`\n${total} passed, ${failed} failed, in ${rows.length} suite(s). Logs: ${outDir}`);
if (!baseline && !flag('no-baseline')) console.log(`(no baseline at ${baselinePath} — dropped checks cannot be detected)`);
for (const d of dropped) {
  console.log(`DROPPED  ${d.suite}: ${d.name}`);
  if (onCi) console.log(`::error title=${d.suite}%3A check no longer reported::${d.name}`);
}
if (added.length) console.log(`${added.length} new check(s) not in the baseline — run with --write-baseline to accept them.`);

const ok = rows.every((r) => r.code === 0) && dropped.length === 0;

if (flag('write-baseline')) {
  if (!ok || only) {
    console.log('baseline not written: it is only written from a full, all-green run');
  } else {
    writeFileSync(baselinePath, `${JSON.stringify(names, null, 2)}\n`);
    console.log(`baseline written: ${baselinePath}`);
  }
}

if (onCi && process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    '| suite | passed | failed | time | status |', '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.suite} | ${r.passed} | ${r.failed} | ${Math.round(r.seconds)}s | ${r.crashed ? 'crashed' : r.code === 0 ? 'ok' : `exit ${r.code}`} |`),
    '',
    ...records.filter((r) => r.name !== undefined && !r.ok).map((r) => `- **${r.suite}**: ${r.name}${r.detail ? ` — ${r.detail}` : ''}`),
    ...dropped.map((d) => `- **${d.suite}**: no longer reported — ${d.name}`),
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

process.exit(ok ? 0 : 1);
