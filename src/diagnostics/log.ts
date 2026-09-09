/**
 * A session log the operator can hand over.
 *
 * This exists because of how the last fortnight went. Every fault on a real
 * device — a black passthrough, a session that would not start, a tap that did
 * not place — was diagnosed through screenshots and guesses, because nothing
 * that happened on the phone could be read anywhere else. Several of those
 * rounds were spent on my wrong guesses, and one on a diagnostic of mine that
 * was itself lying. A file the operator can send is worth more than any number
 * of questions.
 *
 * It is bounded, it holds no images unless one is deliberately attached, and it
 * carries nothing about the operator: what the device is, what the browser
 * granted, what the app did, and what failed.
 */

export type LogKind = 'ar' | 'xr' | 'place' | 'render' | 'error' | 'note' | 'capture';

export interface LogEntry {
  /** Milliseconds since the page loaded — the only clock every layer shares. */
  t: number;
  kind: LogKind;
  message: string;
  data?: Record<string, unknown>;
}

/** Enough for a long session on the floor; old entries fall off the front. */
const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
let installed = false;

export function logEvent(kind: LogKind, message: string, data?: Record<string, unknown>): void {
  entries.push({
    t: Math.round(typeof performance !== 'undefined' ? performance.now() : 0),
    kind,
    message,
    ...(data ? { data } : {}),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function logEntries(): LogEntry[] {
  return entries.slice();
}

export function clearLog(): void {
  entries.length = 0;
}

/**
 * Catch what the app never sees.
 *
 * A render loop that throws, a promise nobody awaited, a script that failed to
 * load: on a desktop these are one keypress away in a console, and on a phone
 * they are invisible. They are the failures most worth having.
 */
export function installErrorCapture(target: Window = window): () => void {
  if (installed) return () => undefined;
  installed = true;
  const onError = (event: ErrorEvent): void => {
    logEvent('error', event.message || 'script error', {
      source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
      stack: event.error instanceof Error ? event.error.stack?.slice(0, 800) : undefined,
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    logEvent('error', reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : `unhandled rejection: ${String(reason).slice(0, 200)}`, {
      stack: reason instanceof Error ? reason.stack?.slice(0, 800) : undefined,
    });
  };
  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);
  return () => {
    installed = false;
    target.removeEventListener('error', onError as EventListener);
    target.removeEventListener('unhandledrejection', onRejection as EventListener);
  };
}
