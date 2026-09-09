import { afterEach, describe, expect, it } from 'vitest';
import { buildReport, reconcileGranted } from './report';
import { setActiveManager } from '../render/babylon/managerRegistry';
import type { SceneManager } from '../render/babylon/SceneManager';
import type { Capabilities } from '../engine/tracking/capabilities';

const caps = (): Capabilities => ({
  secureContext: true, webgl2: true, webxrSupported: true, immersiveAr: true,
  hitTestGranted: false, depthSensingGranted: false, planeDetectionGranted: false,
  anchorsGranted: false, camera: true, motionNeedsPermission: false,
  deviceOrientation: true, barcodeDetector: true, quickLook: false,
  isIOS: false, isIPad: false, recommended: 'webxr', notes: [],
} as unknown as Capabilities);

/** A manager that reports the session the second real device log described. */
const managerWith = (features: string[], tracking?: unknown) => ({
  renderStats: () => ({ xr: true }),
  xrReady: () => false,
  xrFailure: async () => undefined,
  xrSessionInfo: async () => ({
    space: 'local-floor', features,
    camera: { requested: true, granted: features.includes('camera-access') },
    ...(tracking ? { tracking } : {}),
  }),
}) as unknown as SceneManager;

afterEach(() => setActiveManager(undefined));

describe('a report that does not contradict itself', () => {
  it('lets a session answer what capability probing cannot', () => {
    // `isSessionSupported` says nothing about features, so these start false
    // meaning "not confirmed" — and a file that says `anchorsGranted: false`
    // beside `features: [anchors]` reads as a bug in the app, not as caution.
    const granted = reconcileGranted(caps(), ['anchors', 'hit-test', 'local-floor', 'dom-overlay']);
    expect(granted.hitTestGranted).toBe(true);
    expect(granted.anchorsGranted).toBe(true);
    // And says nothing new about what the session did not list.
    expect(granted.depthSensingGranted).toBe(false);
    expect(granted.planeDetectionGranted).toBe(false);
  });

  it('leaves the flags alone when no session has run', () => {
    expect(reconcileGranted(caps(), [])).toEqual(caps());
  });

  it('carries the reconciled flags and the tracking state into the file', async () => {
    setActiveManager(managerWith(
      ['anchors', 'camera-access', 'local', 'viewer', 'hit-test', 'dom-overlay', 'local-floor'],
      { ready: true, reason: 'settled', goodFrames: 30, emulated: false, hasHit: true, waitedMs: 900 },
    ));
    const report = await buildReport(caps());
    expect(report.capabilities?.hitTestGranted).toBe(true);
    expect(report.capabilities?.anchorsGranted).toBe(true);
    expect(report.ar.xrSession?.features).toContain('camera-access');
    // The next "it was shaky at first" should arrive with its own explanation.
    expect(report.ar.xrSession?.tracking?.reason).toBe('settled');
    expect(report.ar.xrSession?.tracking?.waitedMs).toBe(900);
  });

  it('asks the session for its state exactly once', async () => {
    let asked = 0;
    const manager = managerWith(['hit-test']);
    const inner = manager.xrSessionInfo.bind(manager);
    (manager as { xrSessionInfo: () => unknown }).xrSessionInfo = () => { asked++; return inner(); };
    setActiveManager(manager);
    await buildReport(caps());
    expect(asked).toBe(1);
  });
});
