/**
 * `/api/errors` on Vercel: the app's error reports, written to the function's
 * log as one JSON line each (Vercel → the project → Logs). The same checks as
 * the bundled server's endpoint: see `server/errorReport.mjs`.
 */
import { acceptErrorReport, MAX_REPORT_BYTES } from '../server/errorReport.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
    return;
  }
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REPORT_BYTES) {
      res.status(413).end();
      return;
    }
    body += chunk.toString('utf8');
  }
  const result = acceptErrorReport(body);
  if (result.ok) console.log(JSON.stringify(result.record));
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.ok ? 204 : result.status).end();
}
