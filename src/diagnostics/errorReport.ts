/**
 * Errors from the field, sent home.
 *
 * The diagnostics file (`log.ts`) only helps when an operator exports it and
 * sends it, and most never will: an error on a phone in a warehouse is simply
 * never heard of. So each uncaught error, unhandled rejection and render crash
 * is also posted, as a small report, to `/api/errors` on the app's own origin
 * (`server/errorReport.mjs` says what the server keeps).
 *
 * A report holds the error and where it happened in the code, the build, the
 * page path and the user agent: no query string (URLs in messages and stacks
 * are scrubbed of theirs), no images, nothing typed, nothing about the
 * operator. At most a few per page view, each distinct error once. Set
 * `VITE_ERROR_REPORT_URL` to send them elsewhere, or to `off` for none; the
 * privacy notice (`public/privacy.html`) describes this.
 */
import { buildStamp } from './build';

export type ErrorReportKind = 'error' | 'rejection' | 'render';

export interface ErrorReport {
  v: 1;
  kind: ErrorReportKind;
  message: string;
  stack?: string;
  source?: string;
  build: { commit: string; at: string };
  page: string;
  ua: string;
  /** Milliseconds since the page loaded. */
  t: number;
}

/** Reports per page view: enough to see what broke, not a flood from a loop. */
export const MAX_REPORTS = 5;

/** A URL's query string and fragment can carry anything: dropped. */
export function scrubUrls(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#()'"]+)[?#][^\s()'"]*/gi, '$1');
}

const clip = (text: string | undefined, max: number) => (text ? scrubUrls(text).slice(0, max) : undefined);

export function makeReport(
  kind: ErrorReportKind,
  message: string,
  extra: { stack?: string; source?: string } = {},
  env: { page: string; ua: string; t: number } = {
    page: typeof location !== 'undefined' ? location.pathname : '/',
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    t: typeof performance !== 'undefined' ? Math.round(performance.now()) : 0,
  },
): ErrorReport {
  return {
    v: 1,
    kind,
    message: clip(message, 500) || 'unknown error',
    stack: clip(extra.stack, 4000),
    source: clip(extra.source, 300),
    build: buildStamp(),
    page: env.page.split(/[?#]/)[0].slice(0, 200),
    ua: env.ua.slice(0, 300),
    t: env.t,
  };
}

/** Posts without holding up the page, or an unload: a beacon where there is one. */
function post(endpoint: string, report: ErrorReport): void {
  const body = JSON.stringify(report);
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'application/json' }))) return;
  } catch { /* fall through to fetch */ }
  void fetch(endpoint, {
    method: 'POST', body, keepalive: true, credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
  }).catch(() => undefined);
}

export interface ErrorReporter {
  report(kind: ErrorReportKind, message: string, extra?: { stack?: string; source?: string }): boolean;
}

export function createErrorReporter(
  endpoint: string,
  send: (endpoint: string, report: ErrorReport) => void = post,
  max = MAX_REPORTS,
): ErrorReporter {
  const seen = new Set<string>();
  let sent = 0;
  return {
    report(kind, message, extra = {}) {
      if (sent >= max) return false;
      const key = `${kind}|${message}|${extra.stack?.split('\n', 2).join('|') ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      sent++;
      try {
        send(endpoint, makeReport(kind, message, extra));
      } catch { /* reporting must never become the error */ }
      return true;
    },
  };
}

let active: ErrorReporter | undefined;

/** Report a render crash the error boundary caught; a no-op when reporting is off. */
export function reportRenderError(error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error));
  active?.report('render', `${e.name}: ${e.message}`, { stack: e.stack });
}

/**
 * Start reporting this page's uncaught errors to `endpoint` (`off`, or empty,
 * for none). Returns the way to stop.
 */
export function installErrorReporting(endpoint: string | undefined, target: Window = window): () => void {
  if (!endpoint || endpoint === 'off') return () => undefined;
  const reporter = createErrorReporter(endpoint);
  active = reporter;
  const onError = (event: ErrorEvent): void => {
    reporter.report('error', event.message || 'script error', {
      stack: event.error instanceof Error ? event.error.stack : undefined,
      source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    reporter.report('rejection', reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : `unhandled rejection: ${String(reason).slice(0, 200)}`, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };
  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);
  return () => {
    if (active === reporter) active = undefined;
    target.removeEventListener('error', onError as EventListener);
    target.removeEventListener('unhandledrejection', onRejection as EventListener);
  };
}
