/**
 * Error reports from the app in the field: what is accepted, and what is kept.
 *
 * A phone that hits an error says nothing unless the operator exports a
 * diagnostics file, and most never will. So the app sends a small report of
 * each error (see `src/diagnostics/errorReport.ts`) to `/api/errors`, served by
 * the bundled server (`serve.mjs`) and on Vercel by `api/errors.js`. Both pass
 * it through here and write the result to their log as one JSON line.
 *
 * What is kept is what the client already limits itself to, checked again
 * here, because anyone can post to the endpoint: the error's kind, message,
 * stack and source, the build, the page path, the browser's user agent and the
 * time. Never the client's IP address, a query string, cookies or any other
 * header. Nothing else the request carries is stored.
 */

/** Larger requests are refused before they are read in full. */
export const MAX_REPORT_BYTES = 16 * 1024;

const KINDS = new Set(['error', 'rejection', 'render']);
const LIMITS = { message: 500, stack: 4000, source: 300, page: 200, ua: 300, commit: 40, builtAt: 40 };

/** A URL's query string and fragment can carry anything: dropped. */
export function scrubUrls(text) {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#()'"]+)[?#][^\s()'"]*/gi, '$1');
}

const clean = (value, max) => (typeof value === 'string' ? scrubUrls(value).slice(0, max) : undefined);

/**
 * The record to log for a request body, or why it was refused.
 * `now` is the server's own clock: the client's is not trusted.
 */
export function acceptErrorReport(body, now = new Date()) {
  if (typeof body !== 'string' || body.length > MAX_REPORT_BYTES) return { ok: false, status: 413, why: 'too large' };
  let report;
  try {
    report = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, why: 'not JSON' };
  }
  if (!report || typeof report !== 'object' || report.v !== 1 || !KINDS.has(report.kind)
    || typeof report.message !== 'string' || !report.message) {
    return { ok: false, status: 400, why: 'not an error report' };
  }
  const page = clean(report.page, LIMITS.page);
  return {
    ok: true,
    record: {
      type: 'client-error',
      at: now.toISOString(),
      kind: report.kind,
      message: clean(report.message, LIMITS.message),
      stack: clean(report.stack, LIMITS.stack),
      source: clean(report.source, LIMITS.source),
      build: {
        commit: clean(report.build?.commit, LIMITS.commit),
        at: clean(report.build?.at, LIMITS.builtAt),
      },
      // The path only, whatever was sent.
      page: page?.startsWith('/') ? page.split(/[?#]/)[0] : undefined,
      ua: clean(report.ua, LIMITS.ua),
      sinceLoadMs: Number.isFinite(report.t) ? Math.max(0, Math.round(report.t)) : undefined,
    },
  };
}
