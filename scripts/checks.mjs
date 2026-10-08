/**
 * The one way a browser check reports — shared by every suite in this folder.
 *
 * Each suite used to carry its own copy of the same four lines, and its own
 * idea of where the app was served (two said :8080, five said :4173). Worse,
 * a check that failed on CI said so only in a job log that is hosted where
 * the tools reading this repository cannot fetch it: for a week every push to
 * `main` failed `ar-verify`, and nothing that could be read said which check.
 *
 * So, from here:
 *  - the console line is exactly what it was (`PASS  name — detail`), so a
 *    log can still be diffed line by line against an earlier run;
 *  - on GitHub Actions a failure is also an annotation, which the checks API
 *    serves to anyone who can read the repository, and so is a suite that
 *    crashes outright, with its error, rather than an exit code and nothing;
 *  - with `CHECKS_JSON` set, every result is appended to that file as one
 *    JSON line — what `check-all.mjs` reads to compare runs.
 */
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

/** Where the app under test is served. `vite preview`'s port by default. */
export const PREVIEW_URL = process.env.PREVIEW_URL ?? 'http://localhost:4173/';

const onCi = process.env.GITHUB_ACTIONS === 'true';

/** GitHub workflow-command escaping: data, and the stricter rule for properties. */
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function annotate(suite, title, message) {
  if (onCi) console.log(`::error title=${escapeProperty(`${suite}: ${title}`)}::${escapeData(message)}`);
}

/**
 * A suite's reporter. `suite` defaults to the running script's name.
 *
 *   const { check, finish } = createChecks();
 *   check('the thing works', ok, 'what was measured');
 *   finish('all thing checks passed');
 */
export function createChecks(suite = basename(process.argv[1] ?? 'checks', '.mjs')) {
  const failures = [];
  const record = (entry) => {
    if (!process.env.CHECKS_JSON) return;
    try {
      appendFileSync(process.env.CHECKS_JSON, `${JSON.stringify({ suite, ...entry })}\n`);
    } catch { /* a report that cannot be written must not fail the checks */ }
  };

  const check = (name, ok, detail) => {
    const passed = Boolean(ok);
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    record({ name, ok: passed, ...(detail !== undefined ? { detail: String(detail) } : {}) });
    if (!passed) {
      failures.push(name);
      annotate(suite, 'check failed', `${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  // A suite that throws stops at the first broken step and used to leave only
  // a stack trace in a log nobody could fetch. Say which suite, and what.
  const crashed = (error) => {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(`CRASH  ${suite}: ${message}`);
    record({ crashed: true, error: message.slice(0, 2000) });
    annotate(suite, 'crashed', message.slice(0, 4000));
    process.exit(2);
  };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);

  const finish = (passMessage = 'all checks passed') => {
    console.log(failures.length ? `\n${failures.length} FAILED` : `\n${passMessage}`);
    record({ finished: true, failed: failures.length });
    process.exit(failures.length ? 1 : 0);
  };

  return { check, failures, finish };
}
