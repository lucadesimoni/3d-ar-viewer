import { describe, expect, it, vi } from 'vitest';
import { copyReport, exportReport, reportFileName } from './export';
import type { DiagnosticsReport } from './report';

const report = { version: 1, at: 'now', log: [{ t: 1, kind: 'ar', message: 'app started' }] } as unknown as DiagnosticsReport;

/** A document that records the anchors the export clicks. */
function recordingDoc() {
  const clicked: { href: string; download: string }[] = [];
  return {
    clicked,
    doc: {
      createElement: () => {
        const link = document.createElement('a');
        link.click = () => { clicked.push({ href: link.href, download: link.download }); };
        return link;
      },
      body: document.body,
    } as unknown as Document,
  };
}

describe('getting the log off a device that may not do downloads', () => {
  it('uses the share sheet where the platform says it can share the file', async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    const result = await exportReport(report, {
      navigator: { share, canShare: () => true },
      document: recordingDoc().doc,
    });
    expect(result.how).toBe('share');
    const shared = share.mock.calls[0][0];
    const file = shared.files?.[0];
    expect(file?.name).toMatch(/^spatial-ar-.*\.json$/);
    expect(file?.type).toBe('application/json');
    expect(await file?.text().then((t) => JSON.parse(t).version)).toBe(1);
  });

  it('does not call share when the platform refuses this file', async () => {
    // iOS advertises sharing and refuses files in some hosts; calling anyway
    // throws a TypeError that reads like a bug in the app.
    const share = vi.fn(async (_data: ShareData) => {});
    const { doc, clicked } = recordingDoc();
    const result = await exportReport(report, {
      navigator: { share, canShare: () => false }, document: doc,
    });
    expect(share).not.toHaveBeenCalled();
    expect(result.how).toBe('download');
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toMatch(/^spatial-ar-.*\.json$/);
  });

  it('reports a cancelled share as cancelled, never as saved', async () => {
    // The alternative is a log that both people believe was sent. A cancelled
    // share is a DOMException, which is not an `Error` in every host — the
    // first version of this check tested `instanceof Error` and let a cancelled
    // share fall through to a download nobody asked for.
    const share = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); });
    const { doc, clicked } = recordingDoc();
    await expect(exportReport(report, {
      navigator: { share, canShare: () => true }, document: doc,
    })).rejects.toThrow(/cancelled/);
    expect(clicked).toHaveLength(0);
  });

  it('still saves when a platform that said it could share then could not', async () => {
    const share = vi.fn(async () => { throw new TypeError('not supported after all'); });
    const { doc, clicked } = recordingDoc();
    const result = await exportReport(report, {
      navigator: { share, canShare: () => true }, document: doc,
    });
    expect(result.how).toBe('download');
    expect(clicked).toHaveLength(1);
  });

  it('says out loud that a silent host may have saved nothing', async () => {
    // There is no probe for this: `'download' in anchor` is true in a web view
    // that ignores downloads, because the property is on the prototype. The
    // sentence is the only thing standing between that and a wasted round trip.
    const result = await exportReport(report, { navigator: {}, document: recordingDoc().doc });
    expect(result.how).toBe('download');
    expect(result.message).toMatch(/if nothing arrived/i);
  });

  it('names the file by the moment it was taken', () => {
    expect(reportFileName(new Date('2026-09-09T11:55:49.303Z')))
      .toBe('spatial-ar-2026-09-09T11-55-49-303Z.json');
  });
});

describe('the route that needs nothing from the platform', () => {
  it('copies to the clipboard where there is one', async () => {
    // The App Clip's web view is the case this exists for: the next iPad log
    // has to come out of it, and it may do neither share nor download.
    const writeText = vi.fn(async (_text: string) => {});
    const result = await copyReport(report, { navigator: { clipboard: { writeText } } });
    expect(result.how).toBe('clipboard');
    expect(JSON.parse(writeText.mock.calls[0][0]).log[0].message).toBe('app started');
  });

  it('returns the text either way, so a refused clipboard is still readable', async () => {
    const refuse = vi.fn(async () => { throw new Error('denied'); });
    for (const nav of [{}, { clipboard: { writeText: refuse } }]) {
      const result = await copyReport(report, { navigator: nav });
      expect(result.how).toBe('text');
      expect(JSON.parse(result.text).version).toBe(1);
    }
  });
});
