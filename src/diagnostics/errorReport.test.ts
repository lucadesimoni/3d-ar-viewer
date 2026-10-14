import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorReporter, installErrorReporting, makeReport, MAX_REPORTS, scrubUrls, type ErrorReport } from './errorReport';
// The server's own check, so what the client sends is what the server keeps.
import { acceptErrorReport } from '../../server/errorReport.mjs';

const env = { page: '/', ua: 'test', t: 1 };

describe('error reports', () => {
  it('drop every URL\'s query string and fragment', () => {
    expect(scrubUrls('at https://x.example/assets/a.js?token=abc#frag:1:2 and http://h/p?q=1'))
      .toBe('at https://x.example/assets/a.js and http://h/p');
    const r = makeReport('error', 'failed https://h/a?parentOrigin=https://customer.example', {
      stack: 'Error\n    at f (https://h/assets/i.js?v=1:10:5)',
    }, { page: '/viewer?assembly=secret-part#x', ua: 'UA', t: 12 });
    expect(r.message).toBe('failed https://h/a');
    expect(r.stack).toBe('Error\n    at f (https://h/assets/i.js)');
    expect(r.page).toBe('/viewer');
  });

  it('send each distinct error once, and only a few per page', () => {
    const sent: ErrorReport[] = [];
    const reporter = createErrorReporter('/api/errors', (_, r) => sent.push(r));
    expect(reporter.report('error', 'same')).toBe(true);
    expect(reporter.report('error', 'same')).toBe(false);
    for (let i = 0; i < 20; i++) reporter.report('error', `loop ${i}`);
    expect(sent).toHaveLength(MAX_REPORTS);
  });

  it('never throw out of the reporter', () => {
    const reporter = createErrorReporter('/api/errors', () => { throw new Error('offline'); });
    expect(() => reporter.report('rejection', 'x')).not.toThrow();
  });

  describe('installed on a page', () => {
    let stop = () => undefined as void;
    afterEach(() => { stop(); vi.unstubAllGlobals(); });

    it('report uncaught errors and unhandled rejections', () => {
      const beacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
      vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon, userAgent: 'UA' });
      stop = installErrorReporting('/api/errors');
      window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));
      const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
      Object.defineProperty(rejection, 'reason', { value: new TypeError('nope') });
      window.dispatchEvent(rejection);
      expect(beacon).toHaveBeenCalledTimes(2);
      expect(beacon.mock.calls[0][0]).toBe('/api/errors');
    });

    it('send nothing when switched off', () => {
      const beacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
      vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon });
      stop = installErrorReporting('off');
      window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }));
      expect(beacon).not.toHaveBeenCalled();
    });
  });
});

describe('the server', () => {
  it('keeps a report the app sends', () => {
    const report = makeReport('render', 'TypeError: x is undefined', { stack: 'at a (https://h/assets/a.js:1:2)' }, env);
    const result = acceptErrorReport(JSON.stringify(report), new Date('2026-10-14T00:00:00Z'));
    expect(result.ok).toBe(true);
    expect(result.record).toMatchObject({
      type: 'client-error', at: '2026-10-14T00:00:00.000Z', kind: 'render',
      message: 'TypeError: x is undefined', page: '/', ua: 'test', sinceLoadMs: 1,
    });
  });

  it('refuses anything else, and keeps no field it was not asked to', () => {
    expect(acceptErrorReport('not json').status).toBe(400);
    expect(acceptErrorReport(JSON.stringify({ v: 1, kind: 'other', message: 'x' })).status).toBe(400);
    expect(acceptErrorReport('x'.repeat(17 * 1024)).status).toBe(413);
    const sneaky = { ...makeReport('error', 'x', {}, env), ip: '1.2.3.4', email: 'a@b.c', page: '/p?email=a@b.c' };
    const { record } = acceptErrorReport(JSON.stringify(sneaky));
    expect(JSON.stringify(record)).not.toMatch(/1\.2\.3\.4|a@b\.c/);
    expect(record?.page).toBe('/p');
  });
});
