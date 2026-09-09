/**
 * Everything about this session, in one file.
 *
 * The point is that one button on the shop floor replaces a round of
 * screenshots and questions. So it gathers what has actually been needed to
 * find a fault here: what the device is, what the browser granted, which
 * renderer is running, what the AR session did or refused to do, and the
 * sequence of events with the errors in it.
 */
import { logEntries, type LogEntry } from './log';
import { buildStamp, type BuildStamp } from './build';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { useStore } from '../state/store';
import type { Capabilities } from '../engine/tracking/capabilities';

export interface DiagnosticsReport {
  version: 1;
  /** Which build this came from — see `diagnostics/build`. */
  build: BuildStamp;
  at: string;
  /** Milliseconds the page has been open. */
  uptimeMs: number;
  page: {
    url: string;
    secureContext: boolean;
    embedded: boolean;
    /**
     * How big the app's own box actually is, and what it thinks it should be.
     *
     * An iPad inside the Needle App Clip came back with a render canvas
     * measuring 0×0 in a window of 1180×820, and a screenshot of an AR session
     * with the model correctly composited over the room and not one control
     * anywhere. A collapsed app box explains both at once — the DOM overlay
     * shows what the page draws, and a page with no height draws nothing — but
     * nothing in the file said which of the four measurements had collapsed.
     */
    layout?: {
      /** `window.innerWidth/Height`. */
      window: [number, number];
      /** What `visualViewport` reports, which is what `--app-h` is set from. */
      visual?: [number, number];
      visualScale?: number;
      /** The value actually published as `--app-h`, in CSS pixels. */
      appHeightVar: string;
      /** The `.app` element's own box. */
      app: [number, number];
      /** Which of the classes that hide the canvas are on. */
      classes: string;
    };
  };
  device: {
    userAgent: string;
    platform: string;
    devicePixelRatio: number;
    viewport: [number, number];
    hardwareConcurrency: number;
    /** Chrome only; absent elsewhere rather than guessed. */
    deviceMemoryGB?: number;
  };
  capabilities?: Capabilities;
  ar: {
    source: string | undefined;
    placement: string;
    mode: string;
    motion: boolean;
    anchored: boolean;
    error: string | undefined;
    /** Whether a tap could enter a session — meaningless while one is running. */
    xrReady: boolean | 'in-session';
    xrFailure?: string;
    xrSession?: Awaited<ReturnType<NonNullable<ReturnType<typeof getActiveManager>>['xrSessionInfo']>>;
  };
  render?: ReturnType<NonNullable<ReturnType<typeof getActiveManager>>['renderStats']>;
  assembly: { id: string; name: string; parts: number; steps: number; activeStep?: string };
  /** Attached frames, when the operator captured any. */
  captures: Capture[];
  log: LogEntry[];
}

export interface Capture {
  at: number;
  /** JPEG data URL of the camera frame, downscaled. */
  image: string;
  /** Where the camera was, so the frame can be compared with the geometry. */
  camera: { position: number[]; rotation: number[]; fovDeg: number };
  /** Where each part was expected on screen, 0..1 of the view. */
  parts: { id: string; name: string; x: number; y: number; onScreen: boolean }[];
  note?: string;
}

const captures: Capture[] = [];
/** Frames are large; a handful is evidence, a hundred is an upload problem. */
const MAX_CAPTURES = 8;

export function addCapture(capture: Capture): void {
  captures.push(capture);
  if (captures.length > MAX_CAPTURES) captures.shift();
}

export function capturedFrames(): Capture[] {
  return captures.slice();
}

export function clearCaptures(): void {
  captures.length = 0;
}

/**
 * Let a session that actually ran answer the questions capability probing cannot.
 *
 * `isSessionSupported` says nothing about features, so `capabilities.ts` reports
 * the four feature flags as `false` — honestly meaning "not confirmed". In a
 * report that also lists `hit-test`, `anchors` and `camera-access` as granted by
 * the running session, that reads as a contradiction, and it cost me an hour of
 * reading the first real device log. A session knows; use what it knows.
 */
export function reconcileGranted(caps: Capabilities, features: string[]): Capabilities {
  if (!features.length) return caps;
  const has = (name: string): boolean => features.includes(name);
  return {
    ...caps,
    hitTestGranted: caps.hitTestGranted || has('hit-test'),
    anchorsGranted: caps.anchorsGranted || has('anchors'),
    depthSensingGranted: caps.depthSensingGranted || has('depth-sensing'),
    planeDetectionGranted: caps.planeDetectionGranted || has('plane-detection'),
  };
}

/** Measure the app's box, rather than assume the CSS did what it was told. */
function pageLayout(): DiagnosticsReport['page']['layout'] {
  const app = document.querySelector('.app');
  const rect = app?.getBoundingClientRect();
  const vv = window.visualViewport;
  return {
    window: [window.innerWidth, window.innerHeight],
    ...(vv ? { visual: [Math.round(vv.width), Math.round(vv.height)], visualScale: vv.scale } : {}),
    appHeightVar: document.documentElement.style.getPropertyValue('--app-h') || 'unset',
    app: [Math.round(rect?.width ?? 0), Math.round(rect?.height ?? 0)],
    classes: app?.className ?? 'no .app element',
  };
}

export async function buildReport(capabilities?: Capabilities): Promise<DiagnosticsReport> {
  const manager = getActiveManager();
  const state = useStore.getState();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const xrSession = manager ? await manager.xrSessionInfo() : undefined;
  return {
    version: 1,
    build: buildStamp(),
    at: new Date().toISOString(),
    uptimeMs: Math.round(performance.now()),
    page: {
      url: location.href,
      secureContext: window.isSecureContext,
      embedded: window.parent !== window,
      layout: pageLayout(),
    },
    device: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      devicePixelRatio: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      hardwareConcurrency: navigator.hardwareConcurrency,
      ...(typeof nav.deviceMemory === 'number' ? { deviceMemoryGB: nav.deviceMemory } : {}),
    },
    ...(capabilities
      ? { capabilities: reconcileGranted(capabilities, xrSession?.features ?? []) }
      : {}),
    ar: {
      source: state.arSource,
      placement: state.arPlacement,
      mode: state.arMode,
      motion: state.arMotion,
      anchored: Boolean(state.anchor),
      error: state.arError,
      xrReady: manager?.renderStats().xr ? 'in-session' : (manager?.xrReady() ?? false),
      ...(manager ? { xrFailure: await manager.xrFailure() } : {}),
      ...(xrSession ? { xrSession } : {}),
    },
    ...(manager ? { render: manager.renderStats() } : {}),
    assembly: {
      id: state.assembly.id,
      name: state.assembly.name,
      parts: state.assembly.parts.length,
      steps: state.assembly.steps.length,
      activeStep: state.activeStepId,
    },
    captures: capturedFrames(),
    log: logEntries(),
  };
}

/** Hand the file to the browser. Nothing leaves the device unless it is sent. */
export function downloadReport(report: DiagnosticsReport): string {
  const name = `spatial-ar-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next turn of the loop: revoking synchronously races the
  // download on some mobile browsers, which then save an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
