/**
 * What this device can actually do, decided at runtime rather than by sniffing
 * a marketing name.
 *
 * The distinction that matters in practice: iOS Safari has no WebXR at all, so
 * "AR on an iPad" means camera passthrough driven by the motion sensors, with
 * AR Quick Look as the escape hatch for a fully tracked look at one sub-assembly.
 */

export type ArMode = 'webxr' | 'camera' | 'quicklook' | 'preview';

export interface Capabilities {
  secureContext: boolean;
  webgl2: boolean;
  webxrSupported: boolean;
  /** `immersive-ar` specifically, not just the presence of `navigator.xr`. */
  immersiveAr: boolean;
  hitTest: boolean;
  depthSensing: boolean;
  planeDetection: boolean;
  anchors: boolean;
  camera: boolean;
  /** iOS 13+ gates motion sensors behind a user gesture. */
  motionNeedsPermission: boolean;
  deviceOrientation: boolean;
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
  const a = document.createElement('a');
  return a.relList?.supports?.('ar') ?? false;
}

/** Probe the device. Cheap enough to call on mount; cache the result yourself. */
export async function detectCapabilities(): Promise<Capabilities> {
  const { isIOS, isIPad } = detectIOS();
  const notes: string[] = [];
  const secureContext = typeof window !== 'undefined' && window.isSecureContext;
  const webgl2 = hasWebGL2();

  const nav = typeof navigator !== 'undefined' ? (navigator as XrNavigator) : undefined;
  const webxrSupported = Boolean(nav?.xr);
  let immersiveAr = false;
  if (nav?.xr) {
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
  if (!webxrSupported) {
    notes.push(
      isIOS
        ? 'iOS Safari does not implement WebXR. Camera passthrough with motion tracking is used instead.'
        : 'This browser does not expose navigator.xr.',
    );
  } else if (!immersiveAr) {
    notes.push('WebXR is present but immersive-ar is not supported on this device.');
  }
  if (!barcodeDetector) {
    notes.push('BarcodeDetector is unavailable — marker re-registration falls back to manual datums.');
  }

  // Feature flags on the session are only knowable once a session is requested;
  // WebXR has no capability query, so these are optimistic and re-checked on start.
  const hitTest = immersiveAr;
  const depthSensing = immersiveAr;
  const planeDetection = immersiveAr;
  const anchors = immersiveAr;

  let recommended: ArMode = 'preview';
  if (immersiveAr && webgl2) recommended = 'webxr';
  else if (camera && secureContext && deviceOrientation) recommended = 'camera';
  else if (quickLook) recommended = 'quicklook';

  return {
    secureContext,
    webgl2,
    webxrSupported,
    immersiveAr,
    hitTest,
    depthSensing,
    planeDetection,
    anchors,
    camera,
    motionNeedsPermission,
    deviceOrientation,
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
  webxr: 'Full 6-DoF tracking with plane detection and real-world occlusion.',
  camera: 'Live camera behind the overlay, orientation from the device sensors. Anchor by touching a datum.',
  quicklook: 'Hands the model to the system AR viewer. Great tracking, no live diagnostics.',
  preview: 'Turntable view of the assembly. Everything except the camera works here.',
};
