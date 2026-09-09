import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectCapabilities } from './capabilities';

const features = ['camera', 'xr-spatial-tracking', 'accelerometer', 'gyroscope', 'magnetometer'];

describe('capability detection', () => {
  const getUserMedia = vi.fn();
  const isSessionSupported = vi.fn();
  let quickLook: boolean;
  let webgl2: boolean;

  beforeEach(() => {
    quickLook = false;
    webgl2 = true;
    isSessionSupported.mockReset().mockResolvedValue(true);
    vi.stubGlobal('navigator', {
      userAgent: 'Android Chrome', maxTouchPoints: 5,
      mediaDevices: { getUserMedia }, xr: { isSessionSupported },
    });
    vi.stubGlobal('DeviceOrientationEvent', class {});
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('document', {
      createElement: (tag: string) => tag === 'canvas'
        ? { getContext: () => webgl2 ? {} : null }
        : { relList: { supports: () => quickLook } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function policy(denied: string[], name = 'permissionsPolicy', known = features) {
    Object.assign(document, {
      [name]: { features: () => known, allowsFeature: (feature: string) => !denied.includes(feature) },
    });
  }

  it('does not advertise unrequested XR session features as granted', async () => {
    const caps = await detectCapabilities();
    expect(caps).toMatchObject({
      recommended: 'webxr', immersiveAr: true, webxrSupported: true,
      hitTestGranted: false, anchorsGranted: false,
      depthSensingGranted: false, planeDetectionGranted: false,
    });
    expect(caps.permissionsPolicy?.camera).toBe('unknown');
    expect(caps.notes.join(' ')).not.toContain('Permissions Policy blocks');
    expect(isSessionSupported).toHaveBeenCalledWith('immersive-ar');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('uses preview when neither XR nor sensors are exposed', async () => {
    Object.assign(navigator, { xr: undefined, mediaDevices: undefined });
    vi.stubGlobal('DeviceOrientationEvent', undefined);
    expect(await detectCapabilities()).toMatchObject({
      webxrSupported: false, immersiveAr: false, camera: false,
      deviceOrientation: false, motionNeedsPermission: false, recommended: 'preview',
    });
  });

  it.each([
    ['iPhone', 1, false],
    ['Macintosh', 5, true],
  ])('uses gated camera orientation on iOS-style %s without inventing a grant', async (ua, touches, isIPad) => {
    const requestPermission = vi.fn();
    Object.assign(navigator, { xr: undefined, userAgent: ua, maxTouchPoints: touches });
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission });
    expect(await detectCapabilities()).toMatchObject({
      isIOS: true, isIPad, recommended: 'camera', motionNeedsPermission: true,
      deviceOrientation: true, webxrSupported: false,
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('falls back to Quick Look when iOS has no orientation API', async () => {
    Object.assign(navigator, { xr: undefined, userAgent: 'iPhone' });
    vi.stubGlobal('DeviceOrientationEvent', undefined);
    quickLook = true;
    expect((await detectCapabilities()).recommended).toBe('quicklook');
  });

  it.each(['permissionsPolicy', 'featurePolicy'])('identifies embedding denials through %s without hiding APIs', async (name) => {
    policy(features, name);
    const caps = await detectCapabilities();
    expect(caps).toMatchObject({
      camera: true, deviceOrientation: true, webxrSupported: true,
      immersiveAr: false, recommended: 'preview',
    });
    expect(isSessionSupported).not.toHaveBeenCalled();
    for (const feature of features) {
      expect(caps.notes).toContain(`Permissions Policy blocks ${feature}. The embedding host must allow it in its policy and iframe allow attribute.`);
    }
  });

  it.each(['camera', 'accelerometer', 'gyroscope'])('rules out camera mode when %s is denied', async (feature) => {
    Object.assign(navigator, { xr: undefined });
    policy([feature]);
    expect((await detectCapabilities()).recommended).toBe('preview');
  });

  it('does not rule out relative orientation for magnetometer denial alone', async () => {
    Object.assign(navigator, { xr: undefined });
    policy(['magnetometer']);
    const caps = await detectCapabilities();
    expect(caps.recommended).toBe('camera');
    expect(caps.permissionsPolicy?.magnetometer).toBe('denied');
  });

  it('does not mistake unknown policy directives for denials', async () => {
    policy(features, 'permissionsPolicy', []);
    const caps = await detectCapabilities();
    expect(caps.recommended).toBe('webxr');
    expect(Object.values(caps.permissionsPolicy!)).toEqual(features.map(() => 'unknown'));
    expect(caps.notes.join(' ')).not.toContain('Permissions Policy blocks');
  });

  it('keeps policy unknown when false cannot be distinguished from an unknown directive', async () => {
    Object.assign(document, { permissionsPolicy: { allowsFeature: () => false } });
    expect((await detectCapabilities()).permissionsPolicy?.camera).toBe('unknown');
  });

  it('falls back to featurePolicy if the modern implementation throws', async () => {
    Object.assign(document, { permissionsPolicy: { allowsFeature: () => { throw new Error('unsupported'); } } });
    policy(['xr-spatial-tracking'], 'featurePolicy');
    expect(await detectCapabilities()).toMatchObject({
      recommended: 'camera', immersiveAr: false,
      permissionsPolicy: { 'xr-spatial-tracking': 'denied' },
    });
  });

  it('falls back after an XR support probe rejects without claiming permission denial', async () => {
    isSessionSupported.mockRejectedValue(new Error('unsupported'));
    const caps = await detectCapabilities();
    expect(caps.recommended).toBe('camera');
    expect(caps.permissionsPolicy?.['xr-spatial-tracking']).toBe('unknown');
    expect(caps.notes.join(' ')).not.toContain('Permissions Policy blocks');
  });

  it('never recommends a camera or XR session outside a secure context', async () => {
    window.isSecureContext = false;
    expect((await detectCapabilities()).recommended).toBe('preview');
  });

  it('falls back to camera if WebGL2 is missing', async () => {
    webgl2 = false;
    expect((await detectCapabilities()).recommended).toBe('camera');
  });

  it('can probe safely outside a browser', async () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('DeviceOrientationEvent', undefined);
    expect(await detectCapabilities()).toMatchObject({
      secureContext: false, webgl2: false, camera: false, deviceOrientation: false,
      immersiveAr: false, recommended: 'preview', permissionsPolicy: { camera: 'unknown' },
    });
  });
});
