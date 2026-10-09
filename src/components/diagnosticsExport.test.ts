import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsExport } from './DiagnosticsExport';

vi.mock('../diagnostics/report', async (original) => ({
  ...await original<typeof import('../diagnostics/report')>(),
  buildReport: vi.fn(async () => ({ version: 1 })),
}));
vi.mock('../diagnostics/export', () => ({
  exportReport: vi.fn(async () => ({ how: 'download', name: 'x.json', message: 'x.json — if nothing arrived, use the text' })),
  copyReport: vi.fn(async () => ({ how: 'text', text: '{}', message: 'Copied' })),
}));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the answer to "Save diagnostics log"', () => {
  it('is brought into view, not left below the edge of the sheet', async () => {
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(createElement(DiagnosticsExport, { capabilities: undefined, inAr: true })));
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save diagnostics log')!;
    await act(async () => { save.click(); });
    const status = [...host.querySelectorAll('[role="status"]')].find((p) => p.textContent?.includes('x.json'));
    expect(status).toBeDefined();
    expect(scrolled).toHaveBeenCalled();
    expect(scrolled.mock.contexts.at(-1)).toBe(status);
    await act(async () => root.unmount());
  });
});
