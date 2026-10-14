/** Types for `errorReport.mjs`, for the app's tests that check against it. */
export const MAX_REPORT_BYTES: number;
export function scrubUrls(text: string): string;
export interface ErrorRecord {
  type: 'client-error';
  at: string;
  kind: string;
  message?: string;
  stack?: string;
  source?: string;
  build: { commit?: string; at?: string };
  page?: string;
  ua?: string;
  sinceLoadMs?: number;
}
export function acceptErrorReport(body: unknown, now?: Date):
  | { ok: true; record: ErrorRecord; status?: undefined }
  | { ok: false; status: number; why?: string; record?: undefined };
