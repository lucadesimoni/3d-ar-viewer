// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = new URL('./check-all.mjs', import.meta.url).pathname;
const reporter = new URL('./checks.mjs', import.meta.url).pathname;

/** A folder of suites: name → the checks it reports, or 'crash'. */
function suites(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'suites-'));
  for (const [name, checks] of Object.entries(spec)) {
    const body = checks === 'crash'
      ? "check('first', true);\nthrow new Error('the page never loaded');"
      : checks.map(([n, ok]) => `check(${JSON.stringify(n)}, ${ok});`).join('\n');
    writeFileSync(join(dir, `${name}.mjs`),
      `import { createChecks } from ${JSON.stringify(reporter)};\nconst { check, finish } = createChecks(${JSON.stringify(name)});\n${body}\nfinish();\n`);
  }
  return dir;
}

function run(dir, names, extra = [], env = {}) {
  const out = join(dir, 'out');
  const r = spawnSync(process.execPath, [runner, `--dir=${dir}`, `--only=${names.join(',')}`, `--out=${out}`,
    `--baseline=${join(dir, 'baseline.json')}`, ...extra], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr, outDir: out };
}

describe('the battery runner', () => {
  it('runs every suite even when an earlier one fails, and fails overall', () => {
    const dir = suites({ a: [['a1', false]], b: [['b1', true], ['b2', true]] });
    const r = run(dir, ['a', 'b']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a: FAIL  a1');
    expect(r.out).toMatch(/b\s+2\s+0\s+\S+\s+ok/);         // b still ran
    expect(r.out).toContain('2 passed, 1 failed, in 2 suite(s)');
    expect(readFileSync(join(r.outDir, 'b.log'), 'utf8')).toContain('PASS  b2');
  });

  it('reports a suite that crashed as crashed', () => {
    const dir = suites({ a: 'crash' });
    const r = run(dir, ['a']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a: CRASH  a: the page never loaded');
    expect(r.out).toMatch(/a\s+1\s+0\s+\S+\s+CRASHED/);
  });

  it('a check that stops being reported fails the run, though everything left passed', () => {
    const dir = suites({ a: [['kept', true]] });
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ a: ['kept', 'quietly skipped'] }));
    const r = run(dir, ['a']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('DROPPED  a: quietly skipped');
  });

  it('writes a baseline only from a full, all-green run', () => {
    const green = suites({ a: [['x', true], ['y', true]] });
    // `--only` is a partial run by definition, so it is refused here too.
    expect(run(green, ['a'], ['--write-baseline']).out).toContain('baseline not written');
    expect(existsSync(join(green, 'baseline.json'))).toBe(false);
  });

  it('on CI, puts a table and the failures in the job summary', () => {
    const dir = suites({ a: [['a1', false]] });
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    run(dir, ['a'], [], { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary });
    const md = readFileSync(summary, 'utf8');
    expect(md).toContain('| a | 0 | 1 |');
    expect(md).toContain('- **a**: a1');
  });
});
