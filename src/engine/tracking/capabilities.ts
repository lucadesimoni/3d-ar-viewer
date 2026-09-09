/**
 * What this device can actually do, decided at runtime rather than by sniffing
 * a marketing name.
 *
 * The distinction that matters in practice: iOS Safari has no WebXR at all, so
 * "AR on an iPad" means camera passthrough driven by the motion sensors, with
 * AR Quick Look as the escape hatch for a fully tracked look at one sub-assembly.
 */

export type ArMode = 'webxr' | 'camera' | 'quicklook' | 'preview';
export type PolicyAccess = 'allowed' | 'denied' | 'unknown';
type PolicyFeature = 'camera' | 'xr-spatial-tracking' | 'accelerometer' | 'gyroscope' | 'magnetometer';

export interface Capabilities {
  secureContext: boolean;
  webgl2: boolean;
  webxrSupported: boolean;
  /** `immersive-ar` specifically, not just the presence of `navigator.xr`. */
  immersiveAr: boolean;
  /**
   * Granted by a session, not offered by the device.
   *
   * These are false until a session actually reports them, and they were named
   * `hitTest` / `anchors` — which reads, in a diagnostics file, as "this phone
   * cannot do hit-test". A real log showed `hitTest: false` beside a session
   * that had just been granted hit-test, and the contradiction cost an hour.
   * `isSessionSupported` says nothing about features; only a session does, and
   * that answer lives in `ar.xrSession.features`.
   */
  hitTestGranted: boolean;
  depthSensingGranted: boolean;
  planeDetectionGranted: boolean;
  anchorsGranted: boolean;
  /** API presence, not a camera permission grant. See permissionsPolicy. */
  camera: boolean;
  /** iOS 13+ gates motion sensors behind a user gesture. */
  motionNeedsPermission: boolean;
  deviceOrientation: boolean;
  /** Effective embedding policy, not the user's permission choice. */
  permissionsPolicy?: Record<PolicyFeature, PolicyAccess>;
  barcodeDetector: boolean;
  quickLook: boolean;
  isIOS: boolean;
  isIPad: boolean;
  /** Best mode available right now. */
  recommended: ArMode;
  /** Human-readable reasons the better modes were ruled out. */
  notes: string[];
}

type XrNavigator = Navigator & {
  xr?: { isSessionSupported(mode: string): Promise<boolean> };
};

type MotionCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

type Policy = {
  allowsFeature?: (feature: string) => boolean;
  features?: () => string[];
};

function policyAccess(feature: PolicyFeature): PolicyAccess {
  if (typeof document === 'undefined') return 'unknown';
  const doc = document as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy };
  for (const policy of [doc.permissionsPolicy, doc.featurePolicy]) {
    if (!policy?.allowsFeature) continue;
    try {
      // Unknown directives can return false, exactly like a denial. Only
      // classify a denial when the browser confirms it knows the directive.
      const known = policy.features?.();
      if (known && !known.includes(feature)) continue;
      if (policy.allowsFeature(feature)) return 'allowed';
      if (known?.includes(feature)) return 'denied';
    } catch {
      // Partial implementations must not rule out an otherwise usable mode.
    }
  }
  return 'unknown';
}

function detectIOS(): { isIOS: boolean; isIPad: boolean } {
  if (typeof navigator === 'undefined') return { isIOS: false, isIPad: false };
  const ua = navigator.userAgent;
  const iPhone = /iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as a Mac; the touch-point count is what gives it away.
  const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return { isIOS: iPhone || iPad, isIPad: iPad };
}

function hasWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

function supportsQuickLook(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const a = document.createElement('a');
    return a.relList?.supports?.('ar') ?? false;
  } catch {
    return false;
  }
}

/** Probe the device. Cheap enough to call on mount; cache the result yourself. */
export async function detectCapabilities(): Promise<Capabilities> {
  const { isIOS, isIPad } = detectIOS();
  const notes: string[] = [];
  const secureContext = typeof window !== 'undefined' && window.isSecureContext;
  const webgl2 = hasWebGL2();
  const permissionsPolicy: Record<PolicyFeature, PolicyAccess> = {
    camera: policyAccess('camera'),
    'xr-spatial-tracking': policyAccess('xr-spatial-tracking'),
    accelerometer: policyAccess('accelerometer'),
    gyroscope: policyAccess('gyroscope'),
    magnetometer: policyAccess('magnetometer'),
  };
  const cameraBlocked = permissionsPolicy.camera === 'denied';
  const xrBlocked = permissionsPolicy['xr-spatial-tracking'] === 'denied';
  // Relative orientation needs accelerometer and gyroscope. Magnetometer
  // denial removes an absolute heading, not all orientation tracking.
  const motionBlocked = permissionsPolicy.accelerometer === 'denied'
    || permissionsPolicy.gyroscope === 'denied';

  const nav = typeof navigator !== 'undefined' ? (navigator as XrNavigator) : undefined;
  const webxrSupported = Boolean(nav?.xr);
  let immersiveAr = false;
  if (nav?.xr && !xrBlocked) {
    try {
      immersiveAr = await nav.xr.isSessionSupported('immersive-ar');
    } catch {
      immersiveAr = false;
    }
  }

  const camera = Boolean(nav?.mediaDevices?.getUserMedia);
  const motionCtor =
    typeof DeviceOrientationEvent !== 'undefined' ? (DeviceOrientationEvent as MotionCtor) : undefined;
  const deviceOrientation = motionCtor !== undefined;
  const motionNeedsPermission = typeof motionCtor?.requestPermission === 'function';
  const barcodeDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;
  const quickLook = supportsQuickLook();

  if (!secureContext) {
    notes.push('Not a secure context — camera and WebXR are blocked. Serve the app over HTTPS.');
  }
  for (const [feature, access] of Object.entries(permissionsPolicy)) {
    if (access === 'denied') {
      notes.push(`Permissions Policy blocks ${feature}. The embedding host must allow it in its policy and iframe allow attribute.`);
    }
  }
  if (!camera) notes.push('This browser exposes no camera API.');
  if (!deviceOrientation) notes.push('Device orientation sensors are unavailable in this browser.');
  // Why the good mode is unavailable matters more than that it is: without
  // WebXR there is no positional tracking, and no amount of work on the
  // passthrough path can invent it. On Android that is usually the *browser*,
  // not the phone — Samsung Internet has no immersive-ar, Chrome does — and
  // that is a fix the operator can apply in ten seconds.
  const noPositional =
    'Without WebXR the overlay has orientation but no position: it turns with you correctly, '
    + 'but walking carries it along instead of leaving it on the bench.';
  if (!webxrSupported) {
    notes.push(
      isIOS
        ? 'This iOS browser does not expose WebXR. Camera passthrough requires camera and motion access.'
        : 'This browser does not expose navigator.xr. On Android, Chrome does — open the app there for real AR tracking.',
    );
    if (!isIOS) notes.push(noPositional);
  } else if (!immersiveAr && !xrBlocked) {
    notes.push(
      isIOS
        ? 'WebXR is present but immersive-ar is not supported on this device.'
        : 'This browser has WebXR but not immersive-ar. Chrome on Android does, with Google Play Services for AR installed.',
    );
    notes.push(noPositional);
  }
  if (!barcodeDetector) {
    notes.push('BarcodeDetector is unavailable — marker re-registration falls back to manual datums.');
  }

  // Session features are not knowable from isSessionSupported. False means
  // "not confirmed granted", never "this device cannot" — hence the names.
  const hitTestGranted = false;
  const depthSensingGranted = false;
  const planeDetectionGranted = false;
  const anchorsGranted = false;

  let recommended: ArMode = 'preview';
  if (immersiveAr && webgl2 && secureContext) recommended = 'webxr';
  else if (camera && secureContext && deviceOrientation && !cameraBlocked && !motionBlocked) recommended = 'camera';
  else if (quickLook) recommended = 'quicklook';

  return {
    secureContext,
    webgl2,
    webxrSupported,
    immersiveAr,
    hitTestGranted,
    depthSensingGranted,
    planeDetectionGranted,
    anchorsGranted,
    camera,
    motionNeedsPermission,
    deviceOrientation,
    permissionsPolicy,
    barcodeDetector,
    quickLook,
    isIOS,
    isIPad,
    recommended,
    notes,
  };
}

export const MODE_LABELS: Record<ArMode, string> = {
  webxr: 'WebXR immersive AR',
  camera: 'Camera passthrough',
  quicklook: 'AR Quick Look',
  preview: '3D preview',
};

export const MODE_BLURBS: Record<ArMode, string> = {
  webxr: 'Full 6-DoF tracking. Placement and optional sensing features depend on the device and session.',
  camera: 'Live camera behind the overlay, orientation from the device sensors — 3 degrees of freedom. '
    + 'Turning is tracked; walking is not, so the overlay travels with you.',
  quicklook: 'Hands the model to the system AR viewer. Great tracking, no live diagnostics.',
  preview: 'Turntable view of the assembly. Everything except the camera works here.',
};
