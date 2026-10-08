// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = new URL('./testing/fixture-suite.mjs', import.meta.url).pathname;

function run(mode, env = {}) {
  const json = join(mkdtempSync(join(tmpdir(), 'checks-')), 'results.jsonl');
  const r = spawnSync(process.execPath, [fixture, mode], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', CHECKS_JSON: json, ...env },
  });
  const records = existsSync(json)
    ? readFileSync(json, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { code: r.status, out: r.stdout, err: r.stderr, records };
}

describe('the shared check reporter', () => {
  it('prints the same PASS line the suites always printed, and exits 0', () => {
    const r = run('pass');
    expect(r.out).toContain('PASS  it starts — measured: 1');
    expect(r.out).toContain('all fixture checks passed');
    expect(r.code).toBe(0);
  });

  it('a failed check fails the run and says which', () => {
    const r = run('fail');
    expect(r.out).toContain('FAIL  a thing that broke — expected 3, got 2: off by one');
    expect(r.out).toContain('1 FAILED');
    expect(r.code).toBe(1);
  });

  it('on GitHub Actions a failure is an annotation, escaped so it survives', () => {
    const r = run('fail', { GITHUB_ACTIONS: 'true' });
    expect(r.out).toContain('::error title=fixture%3A check failed::a thing that broke — expected 3, got 2: off by one');
    expect(run('pass', { GITHUB_ACTIONS: 'true' }).out).not.toContain('::error');
  });

  it.each(['crash', 'reject'])('a suite that dies (%s) says which suite and why, not just an exit code', (mode) => {
    const r = run(mode, { GITHUB_ACTIONS: 'true' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/CRASH {2}fixture: .*(ERR_CONNECTION_REFUSED|selector timed out)/);
    expect(r.out).toMatch(/::error title=fixture%3A crashed::.*(ERR_CONNECTION_REFUSED|selector timed out)/);
    expect(r.records.at(-1)).toMatchObject({ suite: 'fixture', crashed: true });
  });

  it('writes one JSON line per result for the runner to compare', () => {
    const r = run('fail');
    expect(r.records).toEqual([
      { suite: 'fixture', name: 'it starts', ok: true, detail: 'measured: 1' },
      { suite: 'fixture', name: 'a thing that broke', ok: false, detail: 'expected 3, got 2: off by one' },
      { suite: 'fixture', finished: true, failed: 1 },
    ]);
  });
});
