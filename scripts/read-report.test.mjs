// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserOf, extractImages, iosHost, summarise } from './read-report.mjs';

// The shape of a real report, with nothing of anyone's in it.
const report = (over = {}) => ({
  build: { commit: 'abc1234' },
  at: '2026-10-08T13:38:00.505Z',
  device: {
    platform: 'Linux armv81', devicePixelRatio: 2.8125, viewport: [384, 832],
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36 EdgA/153.0.0.0',
  },
  ar: { mode: 'webxr', placement: 'floor', xrSession: { camera: { requested: true, granted: true } } },
  render: { fps: 24.2, frames: 1000, idleFrames: 40, stalls: 0, scaling: 0.3556, frameSource: 'xr-raw' },
  assembly: { id: 'bench-gearbox', name: 'Gearbox', activeStep: 's5' },
  captures: [],
  log: [],
  ...over,
});

describe('reading a device report', () => {
  it('names the browser, not the engine every browser claims to be', () => {
    expect(browserOf(report().device.userAgent)).toBe('EdgA/153.0.0.0');
    expect(browserOf('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36')).toBe('Chrome/131.0.0.0');
    expect(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari 18.0');
  });

  it('a healthy session has nothing to flag', () => {
    expect(summarise(report()).findings).toEqual([]);
  });

  it('flags a studio view drawn below the screen\'s resolution', () => {
    const { findings } = summarise(report({ render: { ...report().render, scaling: 1 } }));
    expect(findings.map((f) => f.text)).toContainEqual(expect.stringMatching(/drawing at 1x CSS pixels of a possible 2\.81x/));
  });

  it('pairs a tap with the anchor jump that followed it', () => {
    const { findings } = summarise(report({ log: [
      { t: 19245, kind: 'xr', message: 'tap ignored — placement is not armed' },
      { t: 19313, kind: 'place', message: 'the platform moved the anchor', data: { byM: 0.967, followed: false } },
      { t: 30000, kind: 'xr', message: 'tap ignored — placement is not armed' },   // nothing after: no finding
    ] }));
    expect(findings).toEqual([{ level: 'info', text: 'at 19.2 s a tap was followed 68 ms later by the anchor moving 0.967 m (not followed)' }]);
  });

  it('flags a re-based room, blank frames, stalls and errors', () => {
    const texts = summarise(report({
      render: { ...report().render, stalls: 2, frameUniform: true },
      log: [
        { t: 5000, kind: 'xr', message: 'camera jumped', data: { byM: 0.97, inMs: 33 } },
        { t: 6000, kind: 'error', message: 'render failed: TypeError: x is undefined' },
      ],
    })).findings.map((f) => f.text).join('\n');
    expect(texts).toMatch(/stalled 2 time/);
    expect(texts).toMatch(/all one colour/);
    expect(texts).toMatch(/camera jumped 0\.97 m in 33 ms/);
    expect(texts).toMatch(/1 error\(s\) in the log — first: render failed/);
  });

  it('writes captured frames out as image files', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const dir = mkdtempSync(join(tmpdir(), 'report-'));
    const paths = extractImages(report({ captures: [{ image: `data:image/png;base64,${png}` }] }), dir);
    expect(paths).toEqual([join(dir, 'capture-0.png')]);
    expect(readFileSync(paths[0]).subarray(1, 4).toString()).toBe('PNG');
  });

  describe('on iOS', () => {
    const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const WEBVIEW = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
    const DESKTOP_IPAD_WEBVIEW = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const ios = (ua, caps, over = {}) => report({
      device: { ...report().device, platform: 'iPhone', userAgent: ua }, capabilities: caps, ...over,
    });

    it('tells Safari from the App Clip\'s web view — an iPad asking for the desktop site included', () => {
      expect(iosHost(ios(SAFARI, { isIOS: true, isIPad: false }))).toBe('safari');
      expect(iosHost(ios(WEBVIEW, { isIOS: true, isIPad: true }))).toBe('webview');
      expect(iosHost(ios(DESKTOP_IPAD_WEBVIEW, { isIOS: true, isIPad: true }))).toBe('webview');
      expect(iosHost(report())).toBeUndefined();
      expect(summarise(ios(WEBVIEW, { isIOS: true, isIPad: true })).facts.device)
        .toBe('iPhone · iPad (iOS 17.5) · iOS web view (the App Clip?)');
    });

    it('flags an App Clip session that gives no camera image', () => {
      const r = ios(WEBVIEW, { isIOS: true, isIPad: true }, { render: { ...report().render, frameSource: 'xr-blind' } });
      expect(summarise(r).findings.map((f) => f.text)).toContainEqual(expect.stringMatching(/App Clip session with no camera image/));
    });

    it('says what the Safari camera path cannot do', () => {
      const r = ios(SAFARI, { isIOS: true, isIPad: false }, { ar: { mode: 'camera', placement: 'floor' } });
      expect(summarise(r).findings.map((f) => f.text)).toContainEqual(expect.stringMatching(/iOS Safari has no WebXR/));
    });
  });
});
