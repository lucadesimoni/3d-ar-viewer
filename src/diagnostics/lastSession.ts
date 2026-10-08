import type { DiagnosticsReport } from './report';

/**
 * The last AR session's report, kept on the device.
 *
 * Inside the Needle App Clip the AR controls have been seen not to appear at
 * all — and the log export lives behind those controls. A report that can
 * only be sent from a screen nobody can reach is a report nobody sends. So
 * while AR runs the report is written here every few seconds and when the
 * session ends, and the next start of the app offers it, from the ordinary
 * page, where the buttons are.
 *
 * Without the camera frames: they are most of a report's size, local storage
 * is a few megabytes at best, and they are someone's room. Their metadata —
 * where the camera was, where the parts were expected — stays.
 */
const KEY = 'spatial-ar:last-ar-report';

export interface SavedReport {
  savedAt: string;
  report: DiagnosticsReport;
}

/** The report minus the images, which are the bulk of it. */
export function withoutImages(report: DiagnosticsReport): DiagnosticsReport {
  return { ...report, captures: report.captures.map((c) => ({ ...c, image: '' })) };
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;            // storage refused: private mode, a locked-down web view
  }
}

/** Keep `report` as the last session's. False when the device would not take it. */
export function saveLastSession(report: DiagnosticsReport, at = new Date()): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const saved: SavedReport = { savedAt: at.toISOString(), report: withoutImages(report) };
    store.setItem(KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;                // full, or refused
  }
}

export function loadLastSession(): SavedReport | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as SavedReport;
    return saved && typeof saved.savedAt === 'string' && saved.report ? saved : undefined;
  } catch {
    return undefined;            // written by another version, or corrupted: not worth offering
  }
}

export function clearLastSession(): void {
  try {
    storage()?.removeItem(KEY);
  } catch { /* nothing to clear */ }
}
