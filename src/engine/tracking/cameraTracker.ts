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
/** Maps the device frame (Z out of the screen) to a camera looking down -Z. */
const SCREEN_TO_CAMERA = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

/** W3C device orientation (ZXY intrinsic) to a quaternion. */
export function orientationToQuaternion(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenAngleDeg = 0,
): Quaternion {
  const euler = new Euler(betaDeg * DEG, gammaDeg * DEG, -alphaDeg * DEG, 'YXZ');
  const q = new Quaternion().setFromEuler(euler);
  q.multiply(SCREEN_TO_CAMERA);
  // Undo the screen rotation so landscape and portrait agree on which way is up.
  q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -screenAngleDeg * DEG));
  return q.normalize();
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
  private smoothed = new Quaternion();
  private firstHeading: number | undefined;
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
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch (err) {
      this.state.error =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Camera access was denied. Enable it in Settings ▸ Safari ▸ Camera.'
          : `Camera unavailable: ${String(err)}`;
      this.state.running = false;
      this.emit();
      return;
    }

    video.srcObject = this.stream;
    video.setAttribute('playsinline', 'true'); // iOS fullscreens the video without this
    video.muted = true;
    await video.play().catch(() => undefined);

    this.listener = (e: DeviceOrientationEvent) => this.onOrientation(e);
    window.addEventListener('deviceorientation', this.listener, true);
    this.state.running = true;
    this.state.error = undefined;
    this.emit();
  }

  private onOrientation(e: DeviceOrientationEvent): void {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const screenAngle = (window.screen?.orientation?.angle ?? 0) as number;
    const target = orientationToQuaternion(e.alpha, e.beta, e.gamma, screenAngle);

    if (!this.state.receivingMotion) {
      this.smoothed.copy(target);
      this.state.receivingMotion = true;
    } else {
      this.smoothed.slerp(target, this.options.smoothing);
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
    if (this.listener) window.removeEventListener('deviceorientation', this.listener, true);
    this.listener = undefined;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    this.state.running = false;
    this.state.receivingMotion = false;
    this.emit();
  }
}
