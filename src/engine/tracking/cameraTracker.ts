import { Euler, Quaternion, Vector3 } from 'three';
import { toQuat } from '../math';
import type { Pose, Quat, Vec3 } from '../types';

/**
 * Orientation-tracked camera passthrough for devices without WebXR — which, at
 * time of writing, means every iPhone and iPad running Safari.
 *
 * What this gives you honestly: three degrees of freedom. The device's rotation
 * is measured well; its translation is not, because integrating consumer
 * accelerometers drifts into metres within seconds. So the assembly is anchored
 * to a point the operator taps on an assumed ground plane, and it stays locked
 * to that direction and distance while they look around. Walking around the
 * bench needs a re-anchor — which the app asks for rather than silently lying
 * about where the part is. Marker re-registration (see `markerTracking`) closes
 * that loop automatically when a fiducial is in view.
 */

export interface CameraTrackerState {
  running: boolean;
  /** Device orientation as a camera pose (position always at the origin). */
  orientation: Quat;
  /** Compass heading in degrees when the platform supplies one. */
  headingDeg?: number;
  /** True once motion events have actually been seen, not just permitted. */
  receivingMotion: boolean;
  /** Rough estimate of accumulated yaw drift, degrees. */
  driftDeg: number;
  error?: string;
}

export interface CameraTrackerOptions {
  /** Height of the device above the assumed ground plane, metres. */
  eyeHeightM?: number;
  /** Vertical field of view of the passthrough camera, degrees. */
  fovDeg?: number;
  /** 0..1 per frame; lower is smoother and laggier. */
  smoothing?: number;
}

type MotionCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

type WebkitOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

const DEG = Math.PI / 180;

/**
 * A step larger than this is not followed until it is confirmed.
 *
 * It is deliberately small. My first attempt set it at 15 degrees, reasoning
 * that nothing faster than 900 degrees a second can be a hand — true, but
 * beside the point: an indoor magnetometer's noise is mostly *below* that, and
 * every one of those readings sailed through. Hand tremor moves a phone by
 * well under two degrees between samples, so anything past five is either a
 * real turn, which will be confirmed immediately, or noise, which will not.
 */
const JUMP_LIMIT_DEG = 5;
/**
 * …but a real fast turn looks exactly the same for a moment. So a big jump is
 * not rejected outright, it is held as a candidate: accepted once this many
 * consecutive samples *agree with it*. An isolated glitch never gets a second
 * vote; a genuine turn has one within about fifty milliseconds. Counting
 * rejections instead — as I first wrote it — accepts the glitch after N
 * samples and then treats the return to reality as another jump, which turns
 * one hiccup into a permanent oscillation.
 */
const CONFIRMATIONS = 3;

/** How closely to follow once a turn is established: responsive, not instant. */
const TURN_SMOOTHING = 0.45;

/** If the chosen event source goes quiet this long, listen to the other one. */
const SOURCE_SILENCE_MS = 1000;

/**
 * How hard to smooth, given how far the reading moved since the last one.
 *
 * A single fixed factor cannot serve both ends: enough smoothing to hold a
 * hand-held phone still is far too much to follow a deliberate turn, and
 * enough to follow the turn lets every tremor through. Small steps are damped
 * hard, large ones followed almost directly.
 */
export function smoothingFactor(stepDeg: number): number {
  return Math.max(0.05, Math.min(0.25, stepDeg / 40));
}

/** Angle between two orientations, in degrees. */
export function angleBetweenDeg(a: Quaternion, b: Quaternion): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return (2 * Math.acos(Math.min(1, dot))) / DEG;
}
/** Maps the device frame (Z out of the screen) to a camera looking down -Z. */
const SCREEN_TO_CAMERA = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

/**
 * W3C device orientation (ZXY intrinsic) to a camera quaternion.
 *
 * The axis each angle belongs on is not interchangeable, and one arrangement
 * looks correct in every test written by hand. At `beta = 90` — a phone held
 * bolt upright — the YXZ order is in gimbal lock, so `alpha` (compass heading)
 * and `gamma` (roll) produce the same rotation and can be swapped without
 * anything appearing to break. Away from upright they cannot: with the two
 * exchanged, the *pitch* of the camera follows the compass, so pointing the
 * phone at the floor and turning on the spot swings the view from 30 degrees
 * down, through level, to 30 degrees up. The overlay is then off screen in a
 * direction that moves as the operator turns to look for it.
 *
 * Beta is the pitch (x), alpha the heading (y), gamma the roll (negated z) —
 * as in the W3C note and three.js's DeviceOrientationControls. `SCREEN_TO_CAMERA`
 * then turns the screen-out frame into a camera looking out of the *back* of
 * the device, and the last term takes out the screen's own rotation.
 * `deviceOrientation.test.ts` pins all of this to what the operator's hands do.
 */
export function orientationToQuaternion(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenAngleDeg = 0,
): Quaternion {
  const euler = new Euler(betaDeg * DEG, alphaDeg * DEG, -gammaDeg * DEG, 'YXZ');
  const q = new Quaternion().setFromEuler(euler);
  q.multiply(SCREEN_TO_CAMERA);
  // Undo the screen rotation so landscape and portrait agree on which way is up.
  q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -screenAngleDeg * DEG));
  return q.normalize();
}


/**
 * Camera constraints, best first.
 *
 * A phone that refuses 1080p from the rear camera will often hand over the
 * front one, or an unspecified one, without complaint — and a picture from the
 * wrong camera beats no AR at all, which is what a single rigid request gets
 * you when the device is busy or the resolution is unavailable.
 */
const CAMERA_ATTEMPTS: MediaStreamConstraints[] = [
  {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  },
  { video: { facingMode: { ideal: 'environment' } }, audio: false },
  { video: true, audio: false },
];

/** How long to wait before trying again after a busy device, ms. */
const RETRY_DELAY_MS = 450;

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const finish = (): void => {
    clearTimeout(timer);
    signal.removeEventListener('abort', finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal.addEventListener('abort', finish, { once: true });
  if (signal.aborted) finish();
});

/**
 * Open the camera, or explain in a sentence why not.
 *
 * `NotReadableError: Could not start video source` is the one worth handling
 * properly: it almost never means broken hardware, it means something else has
 * the camera — another tab of this same app, a video call, the system camera —
 * or that the device had not finished releasing it from the previous session.
 * The second case clears in a fraction of a second, so it is worth one retry
 * before troubling the operator; the first needs a message that says which
 * thing to go and close.
 */
async function openCamera(signal: AbortSignal): Promise<MediaStream | string | undefined> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'This browser exposes no camera API. AR needs a secure (HTTPS) context.';
  }

  let last: unknown;
  for (let attempt = 0; attempt < CAMERA_ATTEMPTS.length; attempt++) {
    for (const wait of [0, RETRY_DELAY_MS]) {
      if (wait) await sleep(wait, signal);
      if (signal.aborted) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia(CAMERA_ATTEMPTS[attempt]);
        // getUserMedia cannot be aborted: a dismissed session must still
        // release a stream that arrives after the permission prompt closes.
        if (signal.aborted) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        return stream;
      } catch (err) {
        if (signal.aborted) return;
        last = err;
        const name = cameraErrorName(err);
        // A refusal and a missing device will not change on a retry.
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotFoundError') {
          return describeCameraError(err);
        }
        // Anything else is worth one more go, then the next constraint set.
        if (wait) break;
      }
    }
  }
  return describeCameraError(last);
}

function cameraErrorName(err: unknown): string {
  // DOMException and errors from another frame need not share our Error class.
  return typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string'
    ? err.name : '';
}

function describeCameraError(err: unknown): string {
  const name = cameraErrorName(err);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was denied. Allow it for this site in the browser\u2019s address-bar permissions, then try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy. Something else is using it \u2014 most often another tab with this app open, or a video call. Close it and try again.';
    case 'NotFoundError':
      return 'No camera found on this device.';
    case 'OverconstrainedError':
      return 'This camera cannot provide a usable video mode.';
    default:
      return `Camera unavailable: ${String(err)}`;
  }
}

export class CameraTracker {
  state: CameraTrackerState = {
    running: false,
    orientation: [0, 0, 0, 1],
    receivingMotion: false,
    driftDeg: 0,
  };

  readonly options: Required<CameraTrackerOptions>;
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  private session: AbortController | undefined;
  private smoothed = new Quaternion();
  private firstHeading: number | undefined;
  /** Which of the two event names this session listens to. */
  private source: string | undefined;
  private lastSourceMs = 0;
  private pending: Quaternion | undefined;
  private confirmations = 0;
  private turning = false;
  private listener: ((e: DeviceOrientationEvent) => void) | undefined;
  private subscribers = new Set<(s: CameraTrackerState) => void>();

  constructor(options: CameraTrackerOptions = {}) {
    this.options = {
      eyeHeightM: options.eyeHeightM ?? 1.35,
      fovDeg: options.fovDeg ?? 60,
      smoothing: options.smoothing ?? 0.35,
    };
  }

  subscribe(fn: (s: CameraTrackerState) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(): void {
    const snapshot = { ...this.state };
    for (const fn of this.subscribers) fn(snapshot);
  }

  /**
   * Ask for motion access. On iOS this *must* be called from inside a user
   * gesture or the prompt never appears and the promise rejects silently.
   */
  static async requestMotionPermission(): Promise<boolean> {
    const ctor =
      typeof DeviceOrientationEvent !== 'undefined'
        ? (DeviceOrientationEvent as MotionCtor)
        : undefined;
    if (!ctor?.requestPermission) return true; // no gate on this platform
    try {
      return (await ctor.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  /** Open the rear camera and start listening to the motion sensors. */
  async start(video: HTMLVideoElement): Promise<void> {
    this.session?.abort();
    this.releaseResources();
    const session = new AbortController();
    this.session = session;
    this.state.error = undefined;
    const stream = await openCamera(session.signal);
    if (session.signal.aborted || this.session !== session || !stream) return;
    if (typeof stream === 'string') {
      this.session = undefined;
      this.state.error = stream;
      this.state.running = false;
      this.emit();
      return;
    }
    this.stream = stream;
    this.video = video;

    try {
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true'); // iOS fullscreens the video without this
      video.muted = true;
      await video.play();
    } catch (err) {
      if (session.signal.aborted || this.session !== session) return;
      this.session = undefined;
      session.abort();
      this.releaseResources();
      this.state.error = `Camera playback failed. Try starting AR again: ${String(err)}`;
      this.emit();
      return;
    }
    if (session.signal.aborted || this.session !== session) return;

    // Two event names, because Android is split on which one it fires: Chrome
    // and Samsung Internet deliver `deviceorientationabsolute` on many devices
    // and nothing at all on the plain name. Listening only for the plain one
    // left the scene camera level while the phone pointed at the floor — the
    // overlay was then placed correctly and rendered somewhere off screen.
    this.listener = (e: DeviceOrientationEvent) => {
      if (!session.signal.aborted && this.session === session) this.onOrientation(e);
    };
    window.addEventListener('deviceorientation', this.listener, true);
    window.addEventListener('deviceorientationabsolute', this.listener, true);
    this.state.running = true;
    this.state.error = undefined;
    this.emit();
  }

  private onOrientation(e: DeviceOrientationEvent): void {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    // Android fires *both* event names, and their alpha references differ — one
    // is gyro-relative, the other magnetometer-absolute. Feeding both into one
    // filter makes it chase two different answers, several degrees apart, sixty
    // times a second. Choose a source and ignore the other; prefer the absolute
    // one, because an anchor fixed to the room needs a reference fixed to the
    // room.
    const now = performance.now();
    if (this.source === undefined) {
      this.source = e.type;
    } else if (this.source !== e.type) {
      // Adopt the absolute reference if it appears — an anchor fixed to the
      // room needs a reference fixed to the room — and adopt anything at all
      // if the chosen source has fallen silent, because locking onto a stream
      // that then stops is a camera frozen for the rest of the session.
      const silent = now - this.lastSourceMs > SOURCE_SILENCE_MS;
      if (e.type !== 'deviceorientationabsolute' && !silent) return;
      this.source = e.type;
      this.state.receivingMotion = false;   // re-seed rather than slerp across
    }
    this.lastSourceMs = now;

    const screenAngle = (window.screen?.orientation?.angle ?? 0) as number;
    const target = orientationToQuaternion(e.alpha, e.beta, e.gamma, screenAngle);

    if (!this.state.receivingMotion) {
      this.smoothed.copy(target);
      this.state.receivingMotion = true;
    } else {
      const step = angleBetweenDeg(this.smoothed, target);
      if (step <= JUMP_LIMIT_DEG) {
        // Ordinary hand movement: damp it, and stop treating anything as a turn.
        this.turning = false;
        this.pending = undefined;
        this.confirmations = 0;
        this.smoothed.slerp(target, smoothingFactor(step));
      } else if (this.turning) {
        // Already established that the operator is turning; keep up with them.
        this.smoothed.slerp(target, TURN_SMOOTHING);
      } else {
        // A big step, out of nowhere. Hold it as a candidate and see whether
        // the samples that follow agree with it. An isolated glitch never gets
        // its second vote; a real turn has one within about a tenth of a second.
        if (this.pending && angleBetweenDeg(this.pending, target) < JUMP_LIMIT_DEG * 3) {
          this.confirmations++;
        } else {
          this.pending = target.clone();
          this.confirmations = 1;
        }
        if (this.confirmations < CONFIRMATIONS) return;
        this.turning = true;
        this.pending = undefined;
        this.confirmations = 0;
        this.smoothed.slerp(target, TURN_SMOOTHING);
      }
    }

    const heading = (e as WebkitOrientationEvent).webkitCompassHeading;
    if (typeof heading === 'number' && Number.isFinite(heading)) {
      this.state.headingDeg = heading;
      if (this.firstHeading === undefined) this.firstHeading = heading;
      // Compass wander is the honest proxy for how far the anchor has slipped.
      const delta = Math.abs(((heading - this.firstHeading + 540) % 360) - 180);
      this.state.driftDeg = delta;
    }

    this.state.orientation = toQuat(this.smoothed);
    this.emit();
  }

  /** Current camera pose. The origin is the operator's head; only rotation is real. */
  cameraPose(): Pose {
    return { position: [0, this.options.eyeHeightM, 0], rotation: this.state.orientation };
  }

  /**
   * Where a screen tap lands on the assumed ground plane.
   *
   * `ndc` is normalised device coordinates (-1..1, y up). Returns `undefined`
   * when the ray points at or above the horizon, which is exactly when a
   * ground-plane intersection would be meaningless.
   */
  raycastToGround(ndc: { x: number; y: number }, aspect: number): Vec3 | undefined {
    const q = new Quaternion(...this.state.orientation);
    const tanHalf = Math.tan((this.options.fovDeg * DEG) / 2);
    const dir = new Vector3(ndc.x * tanHalf * aspect, ndc.y * tanHalf, -1)
      .normalize()
      .applyQuaternion(q);

    const eye = this.options.eyeHeightM;
    if (dir.y > -0.05) return undefined; // looking at or above the horizon
    const t = -eye / dir.y;
    if (!Number.isFinite(t) || t <= 0 || t > 20) return undefined;
    return [dir.x * t, 0, dir.z * t];
  }

  /** Reset the drift baseline — call after a successful re-registration. */
  markRegistered(): void {
    this.firstHeading = this.state.headingDeg;
    this.state.driftDeg = 0;
    this.emit();
  }

  stop(): void {
    this.session?.abort();
    this.session = undefined;
    this.releaseResources();
    this.emit();
  }

  private releaseResources(): void {
    if (this.listener) {
      window.removeEventListener('deviceorientation', this.listener, true);
      window.removeEventListener('deviceorientationabsolute', this.listener, true);
    }
    this.listener = undefined;
    // The next session re-chooses its source: a device can change which name it
    // fires between sessions, and a stale choice would mute it entirely.
    this.source = undefined;
    this.pending = undefined;
    this.confirmations = 0;
    this.turning = false;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    // Do not detach a replacement stream installed by the embedding host.
    if (this.video && this.stream && this.video.srcObject === this.stream) {
      try { this.video.pause(); } catch { /* Some embedded media implementations throw on pause. */ }
      this.video.srcObject = null;
    }
    this.video = undefined;
    this.stream = undefined;
    this.firstHeading = undefined;
    this.state.headingDeg = undefined;
    this.state.driftDeg = 0;
    this.state.running = false;
    this.state.receivingMotion = false;
  }
}
