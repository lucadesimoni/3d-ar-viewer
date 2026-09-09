import type { DiagnosticsReport } from './report';

/**
 * Getting the file off the device, on a device that may not do downloads.
 *
 * `<a download>` was the whole of the export, and it is enough in a browser. It
 * is not enough where the next iPad log has to come from: the Needle Go App
 * Clip hosts this page in a WKWebView, and a WKWebView performs no download
 * unless the host app implements a download delegate. A third party's clip may
 * or may not.
 *
 * The worst part is that it cannot be detected. `'download' in anchor` is true
 * in a web view that will silently ignore it — the property is on the
 * prototype, not a statement of intent — so there is no probe to write and no
 * error to catch. The button says "Saved", nothing is saved, and a round trip
 * is spent on a file that never existed.
 *
 * So: use the share sheet wherever the platform says it can actually share the
 * file (iOS, and web views that support it), fall back to the download, and
 * always offer a second, unconditional route — the text itself — with a line
 * saying to use it if nothing arrived. Nothing leaves the device unless the
 * operator sends it; the share sheet is their own choice of destination.
 */
export type ExportHow = 'share' | 'download' | 'none';
export type CopyHow = 'clipboard' | 'text';

export interface ExportResult {
  how: ExportHow;
  name: string;
  /** What to tell the operator. */
  message: string;
}

export interface CopyResult {
  how: CopyHow;
  /** The JSON, always — the panel shows it whether or not the copy worked. */
  text: string;
  message: string;
}

export function reportFileName(at = new Date()): string {
  return `spatial-ar-${at.toISOString().replace(/[:.]/g, '-')}.json`;
}

/**
 * Only what the export uses.
 *
 * Not `extends Navigator`: the lib declares `share`/`canShare` as always
 * present, and a host that has neither is exactly what this has to describe.
 */
interface ShareCapableNavigator {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
  clipboard?: { writeText: (text: string) => Promise<void> };
}

/** True for a cancelled share — a DOMException, which need not be an `Error`. */
function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

const serialise = (report: DiagnosticsReport): string => JSON.stringify(report, null, 2);

/**
 * Hand the file to the platform: the share sheet if it can take it, else a
 * download. Call from a user gesture — the share sheet needs one.
 *
 * A cancelled share is rethrown rather than falling through to a download: the
 * operator said no, and saving the file anyway is not what they asked for.
 */
export async function exportReport(
  report: DiagnosticsReport,
  env: { navigator?: ShareCapableNavigator; document?: Document } = {},
): Promise<ExportResult> {
  const nav = env.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator);
  const doc = env.document ?? (typeof document === 'undefined' ? undefined : document);
  const name = reportFileName();
  const blob = new Blob([serialise(report)], { type: 'application/json' });

  if (nav?.share && nav.canShare) {
    const file = new File([blob], name, { type: 'application/json' });
    // `canShare` with the actual file, not just `'share' in navigator`: iOS
    // advertises sharing and refuses files in some hosts, and an unguarded
    // `share` there throws a TypeError that reads like a bug in the app.
    if (nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: name });
        return { how: 'share', name, message: `Sent ${name}` };
      } catch (err) {
        if (isAbort(err)) throw err;
        // Anything else: the platform said it could and could not. Try the file.
      }
    }
  }

  if (!doc) return { how: 'none', name, message: 'Nowhere to save the log from here' };
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  doc.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next turn of the loop: revoking synchronously races the
  // download on some mobile browsers, which then save an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return {
    how: 'download', name,
    // Not "Saved": a web view that ignores downloads reports nothing at all,
    // and this is the one sentence that stops that silence costing a day.
    message: `${name} — if nothing arrived, this host ignores downloads: use "Show the log as text"`,
  };
}

/**
 * The route that needs nothing from the platform.
 *
 * The clipboard when it is available, and the text either way, because a
 * clipboard write that quietly fails is the same trap as a download that
 * quietly fails.
 */
export async function copyReport(
  report: DiagnosticsReport,
  env: { navigator?: ShareCapableNavigator } = {},
): Promise<CopyResult> {
  const nav = env.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator);
  const text = serialise(report);
  try {
    if (nav?.clipboard) {
      await nav.clipboard.writeText(text);
      return { how: 'clipboard', text, message: 'Copied — paste it anywhere, or select it below' };
    }
  } catch {
    // No clipboard permission in this host; the text below is the answer.
  }
  return { how: 'text', text, message: 'Select the text below and copy it' };
}
