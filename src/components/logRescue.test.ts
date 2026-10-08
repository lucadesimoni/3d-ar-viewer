import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogRescue, worthOffering, inIosWebView, KEEP_EVERY_MS, CONTROLS_GRACE_MS } from './LogRescue';
import { controlsOnScreen } from '../ui/controlsOnScreen';
import { loadLastSession, saveLastSession, clearLastSession, withoutImages } from '../diagnostics/lastSession';
import { logEntries } from '../diagnostics/log';
import type { DiagnosticsReport } from '../diagnostics/report';

const report = (over: Partial<DiagnosticsReport> = {}): DiagnosticsReport => ({
  version: 1, build: { commit: 'abc' }, at: '2026-10-08T17:00:00.000Z', uptimeMs: 1,
  device: { userAgent: 'Mozilla/5.0 (Linux; Android 10) Chrome/153 Mobile Safari/537.36' },
  capabilities: { isIOS: false, isIPad: false },
  captures: [{ at: 1, image: 'data:image/jpeg;base64,AAAA', camera: { position: [0, 1, 0], rotation: [0, 0, 0, 1], fovDeg: 60 }, parts: [] }],
  log: [],
  ...over,
} as unknown as DiagnosticsReport);

vi.mock('../diagnostics/report', async (original) => ({
  ...await original<typeof import('../diagnostics/report')>(),
  buildReport: vi.fn(async () => report()),
}));

const IPAD_CLIP = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

describe('whether the AR controls are on screen', () => {
  const view = { width: 820, height: 1180 };
  const bar = (top: number, height = 64) => ({ top, left: 10, bottom: top + height, right: 810, width: 800, height });
  it('a bar inside the visible area is', () => expect(controlsOnScreen(bar(1100), view)).toBe(true));
  it('a bar below it — a column taller than the host shows — is not', () => expect(controlsOnScreen(bar(1150), view)).toBe(false));
  it('a collapsed bar, or none at all, is not', () => {
    expect(controlsOnScreen(bar(500, 0), view)).toBe(false);
    expect(controlsOnScreen(undefined, view)).toBe(false);
  });
});

describe('the last AR session, kept on the device', () => {
  beforeEach(() => clearLastSession());

  it('keeps everything but the camera images', () => {
    expect(saveLastSession(report(), new Date('2026-10-08T17:01:00Z'))).toBe(true);
    const saved = loadLastSession()!;
    expect(saved.savedAt).toBe('2026-10-08T17:01:00.000Z');
    expect(saved.report.captures[0].image).toBe('');
    expect(saved.report.captures[0].camera.fovDeg).toBe(60);
    expect(withoutImages(report()).captures[0].image).toBe('');
  });

  it('a device that refuses storage loses only this, quietly', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(saveLastSession(report())).toBe(false);
    vi.restoreAllMocks();
    localStorage.setItem('spatial-ar:last-ar-report', '{not json');
    expect(loadLastSession()).toBeUndefined();
  });

  it('is offered unasked only from where the controls go missing', () => {
    const saved = (r: DiagnosticsReport) => ({ savedAt: 'x', report: r });
    expect(worthOffering(saved(report()))).toBe(false);
    expect(worthOffering(saved(report({ device: { userAgent: IPAD_CLIP } } as never)))).toBe(true);
    expect(worthOffering(saved(report({ log: [{ t: 1, kind: 'ui', message: 'AR controls not on screen' }] } as never)))).toBe(true);
    expect(inIosWebView({ isIOS: true, isIPad: true }, IPAD_CLIP)).toBe(true);
    expect(inIosWebView({ isIOS: true, isIPad: false },
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe(false);
  });
});

describe('getting the log out without the ordinary buttons', () => {
  let root: Root;
  let host: HTMLDivElement;
  const onExitAr = vi.fn();
  const render = async (arActive: boolean) => {
    await act(async () => root.render(createElement(LogRescue, { arActive, onExitAr, capabilities: undefined })));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    clearLastSession();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.querySelectorAll('.ar-bar').forEach((e) => e.remove());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a three-finger tap anywhere opens the log, with a way out of AR', async () => {
    await render(true);
    const touch = new Event('touchstart');
    Object.defineProperty(touch, 'touches', { value: { length: 3 } });
    await act(async () => { document.dispatchEvent(touch); });
    const panel = host.querySelector('[role="dialog"]');
    expect(panel?.textContent).toContain('Save diagnostics log');
    const exit = [...panel!.querySelectorAll('button')].find((b) => b.textContent === 'Exit AR')!;
    await act(async () => exit.click());
    expect(onExitAr).toHaveBeenCalledTimes(1);
  });

  it('with no AR bar on screen, offers a way in at the top — and logs what it measured, once', async () => {
    const before = logEntries().filter((e) => e.message === 'AR controls not on screen').length;
    await render(true);
    expect(host.querySelector('.log-rescue-trigger')).toBeNull();          // not before the grace period
    await act(async () => { vi.advanceTimersByTime(CONTROLS_GRACE_MS + 6000); });
    expect(host.querySelector('.log-rescue-trigger')?.textContent).toMatch(/Controls missing/);
    const logged = logEntries().filter((e) => e.message === 'AR controls not on screen');
    expect(logged.length - before).toBe(1);
    expect(logged.at(-1)?.data).toMatchObject({ bar: null, window: [window.innerWidth, window.innerHeight] });
  });

  it('stays out of the way when the bar is there', async () => {
    const bar = document.createElement('div');
    bar.className = 'ar-bar';
    bar.getBoundingClientRect = () => ({ top: 600, left: 10, bottom: 664, right: 500, width: 490, height: 64 } as DOMRect);
    document.body.append(bar);
    await render(true);
    await act(async () => { vi.advanceTimersByTime(CONTROLS_GRACE_MS + 100); });
    expect(host.querySelector('.log-rescue-trigger')).toBeNull();
  });

  it('keeps the running session on the device, and offers it on the next start', async () => {
    await render(true);
    await act(async () => { vi.advanceTimersByTime(KEEP_EVERY_MS); await Promise.resolve(); });
    expect(loadLastSession()).toBeDefined();

    // Leaving AR keeps the session one last time (asynchronously)…
    await act(async () => root.unmount());
    await act(async () => { await Promise.resolve(); });
    // …then the next start, after a session where the controls were missing.
    saveLastSession(report({ log: [{ t: 1, kind: 'ui', message: 'AR controls not on screen' }] } as never));
    root = createRoot(host);
    await render(false);
    const offer = host.querySelector('.log-rescue-offer');
    expect(offer?.textContent).toMatch(/log of the AR session at .* is\s*saved on this device/);
    const dismiss = [...offer!.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!;
    await act(async () => dismiss.click());
    expect(host.querySelector('.log-rescue-offer')).toBeNull();
    expect(loadLastSession()).toBeUndefined();
  });
});
