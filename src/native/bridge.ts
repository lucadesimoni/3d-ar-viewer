/**
 * The native AR host: the app inside the Spatial AR Android (ARCore) or iOS
 * (ARKit) shell.
 *
 * iPhone Safari has no WebXR, so on iOS the browser can only rotate the
 * overlay with the phone; it cannot follow the phone through the room. The
 * shells (`native/android`, `native/ios`) run the platform's own world tracking
 * and show this same web app over the camera in a transparent web view. This
 * module is the contract between them, version 1:
 *
 *  native → web, by calling `window.spatialNative.receive(message)`:
 *   - `hello`        which platform, what it can do;
 *   - `pose`         per frame: the camera's pose in the session's world
 *                    (right-handed, y up, the camera looking down -z, as WebXR
 *                    and three.js), its vertical field of view, the tracking
 *                    state, and the floor's height once a plane is found;
 *   - `camera-image` a JPEG of the camera frame, when asked for one, with the
 *                    pose it was taken from: for recognition;
 *   - `session`      running, paused or failed.
 *
 *  web → native, through the host's message handler:
 *   - `start` / `stop` the AR session;
 *   - `request-image`  one camera frame, at most `maxWidth` wide.
 *
 * Everything from the native side is checked here before the app sees it.
 * The web view loads the hosted app, and a message that does not parse is
 * dropped, not trusted.
 */
import type { Pose, Quat, Vec3 } from '../engine/types';

export const NATIVE_PROTOCOL_VERSION = 1;

export type NativePlatform = 'android' | 'ios';
export type NativeTracking = 'normal' | 'limited' | 'not-available';

export interface NativeHello {
  type: 'hello';
  version: number;
  platform: NativePlatform;
  /** The shell's own version, for the diagnostics log. */
  appVersion: string;
  /** It can hand over camera frames for recognition. */
  cameraImages: boolean;
}

export interface NativePose {
  type: 'pose';
  /** Milliseconds, the native clock: only differences mean anything. */
  t: number;
  pose: Pose;
  fovDeg: number;
  tracking: NativeTracking;
  /** World y of the floor, once the platform has found a horizontal plane below the camera. */
  floorY?: number;
}

export interface NativeCameraImage {
  type: 'camera-image';
  t: number;
  /** `data:image/jpeg;base64,…` */
  image: string;
  width: number;
  height: number;
  pose: Pose;
  fovDeg: number;
}

export interface NativeSession {
  type: 'session';
  state: 'running' | 'paused' | 'failed';
  reason?: string;
}

export type NativeMessage = NativeHello | NativePose | NativeCameraImage | NativeSession;

export type WebMessage =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'request-image'; maxWidth: number };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(finite);

function parsePose(v: unknown): Pose | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { position, rotation } = v as { position?: unknown; rotation?: unknown };
  if (!vec(position, 3) || !vec(rotation, 4)) return undefined;
  const q = rotation as number[];
  const norm = Math.hypot(q[0], q[1], q[2], q[3]);
  if (norm < 0.5 || norm > 1.5) return undefined;
  return {
    position: [...(position as number[])] as Vec3,
    rotation: [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm] as Quat,
  };
}

const fov = (v: unknown): number | undefined => (finite(v) && v > 5 && v < 170 ? v : undefined);

/** A message from the native side, checked; undefined for anything malformed. */
export function parseNativeMessage(raw: unknown): NativeMessage | undefined {
  let m: unknown = raw;
  if (typeof raw === 'string') {
    try { m = JSON.parse(raw); } catch { return undefined; }
  }
  if (!m || typeof m !== 'object') return undefined;
  const msg = m as Record<string, unknown>;
  switch (msg.type) {
    case 'hello':
      if (!finite(msg.version) || (msg.platform !== 'android' && msg.platform !== 'ios')) return undefined;
      return {
        type: 'hello', version: msg.version, platform: msg.platform,
        appVersion: typeof msg.appVersion === 'string' ? msg.appVersion.slice(0, 40) : 'unknown',
        cameraImages: msg.cameraImages === true,
      };
    case 'pose': {
      const pose = parsePose(msg.pose);
      const f = fov(msg.fovDeg);
      if (!pose || f === undefined || !finite(msg.t)) return undefined;
      const tracking = msg.tracking === 'normal' || msg.tracking === 'limited' ? msg.tracking : 'not-available';
      return { type: 'pose', t: msg.t, pose, fovDeg: f, tracking, ...(finite(msg.floorY) ? { floorY: msg.floorY } : {}) };
    }
    case 'camera-image': {
      const pose = parsePose(msg.pose);
      const f = fov(msg.fovDeg);
      if (!pose || f === undefined || !finite(msg.t) || typeof msg.image !== 'string'
        || !msg.image.startsWith('data:image/jpeg;base64,')
        || !finite(msg.width) || !finite(msg.height) || msg.width < 1 || msg.height < 1) return undefined;
      return { type: 'camera-image', t: msg.t, image: msg.image, width: msg.width, height: msg.height, pose, fovDeg: f };
    }
    case 'session':
      if (msg.state !== 'running' && msg.state !== 'paused' && msg.state !== 'failed') return undefined;
      return { type: 'session', state: msg.state, ...(typeof msg.reason === 'string' ? { reason: msg.reason.slice(0, 300) } : {}) };
    default:
      return undefined;
  }
}

interface AndroidHost { postMessage(json: string): void }
interface IosHost { postMessage(message: unknown): void }
type HostWindow = Window & {
  SpatialNativeHost?: AndroidHost;
  webkit?: { messageHandlers?: { spatialNative?: IosHost } };
  spatialNative?: { receive(message: unknown): void };
};

/** Whether this page is running inside a native shell. */
export function nativeHostAvailable(w: Window = window): boolean {
  const h = w as HostWindow;
  return Boolean(h.SpatialNativeHost?.postMessage || h.webkit?.messageHandlers?.spatialNative?.postMessage);
}

export interface NativeBridge {
  send(message: WebMessage): void;
  /** Every valid message from the native side; returns how to stop listening. */
  subscribe(listener: (message: NativeMessage) => void): () => void;
  /** The `hello`, once it has come. */
  hello(): NativeHello | undefined;
}

let installed: NativeBridge | undefined;

/**
 * The bridge to the native shell, installed once: undefined outside one.
 * Installs `window.spatialNative.receive` for the shell to call.
 */
export function nativeBridge(w: Window = window): NativeBridge | undefined {
  if (installed) return installed;
  if (!nativeHostAvailable(w)) return undefined;
  const h = w as HostWindow;
  const listeners = new Set<(m: NativeMessage) => void>();
  let hello: NativeHello | undefined;
  h.spatialNative = {
    receive(raw: unknown) {
      const message = parseNativeMessage(raw);
      if (!message) return;
      if (message.type === 'hello') hello = message;
      for (const l of [...listeners]) l(message);
    },
  };
  installed = {
    send(message) {
      if (h.SpatialNativeHost) h.SpatialNativeHost.postMessage(JSON.stringify(message));
      else h.webkit?.messageHandlers?.spatialNative?.postMessage(message);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hello: () => hello,
  };
  return installed;
}

/** For tests: forget the installed bridge. */
export function resetNativeBridge(): void {
  installed = undefined;
}
