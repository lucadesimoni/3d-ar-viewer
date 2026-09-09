/**
 * Whether the platform is tracking well enough to place against.
 *
 * A real device log (Android/Edge, `bbd065f+`) shows the cost of not asking.
 * Three seconds into the session the operator tapped, and the anchor landed at
 * y = -0.781 m — 78 cm *below* the floor in a `local-floor` space, whose y = 0
 * is the floor. ARCore had not settled on the floor plane yet. The assembly
 * stood too far away, which reads as "the objects are small", and it wobbled
 * until, at t = 34 s, the platform relocalised by 1.19 m and everything was
 * fine. Nothing was wrong with the placement but its timing.
 *
 * WebXR says so for free: `XRViewerPose.emulatedPosition` is true for as long
 * as the device is guessing its position rather than tracking it. Pair that
 * with "the hit-test is returning surfaces" over a run of consecutive frames
 * and there is a usable answer to "is the floor known yet".
 */

/** Consecutive good frames before placement is armed — about half a second. */
export const SETTLE_FRAMES = 30;

/**
 * After this, place anyway.
 *
 * Some devices never clear `emulatedPosition`, and a phone pointed at a blank
 * white wall may never produce a hit. An operator who cannot place at all is
 * worse off than one who places early and is told so.
 */
export const SETTLE_TIMEOUT_MS = 8000;

export type SettleReason = 'settling' | 'settled' | 'timeout';

export interface TrackingState {
  /** May the operator place? */
  ready: boolean;
  reason: SettleReason;
  /** Consecutive frames with a tracked pose and a surface under the reticle. */
  goodFrames: number;
  /** The platform is still guessing its position rather than tracking it. */
  emulated: boolean;
  /** The hit-test is returning a surface. */
  hasHit: boolean;
  /** Milliseconds since the session started asking. */
  waitedMs: number;
}

const INITIAL: TrackingState = {
  ready: false, reason: 'settling', goodFrames: 0, emulated: true, hasHit: false, waitedMs: 0,
};

export interface SettleTracker {
  /** Feed one frame. Returns the state, whether or not it changed. */
  sample(sample: { emulated: boolean; hasHit: boolean }, nowMs: number): TrackingState;
  state(): TrackingState;
  /** A new session: forget everything and start the clock again. */
  reset(nowMs: number): void;
}

export function createSettleTracker(
  frames = SETTLE_FRAMES, timeoutMs = SETTLE_TIMEOUT_MS,
): SettleTracker {
  let state = INITIAL;
  // Undefined, not zero: `performance.now()` is zero at load, and a falsy test
  // here restarted the clock on every frame — the timeout then never arrived.
  let startedAt: number | undefined;
  return {
    state: () => state,
    reset: (nowMs: number) => { state = INITIAL; startedAt = nowMs; },
    sample({ emulated, hasHit }, nowMs) {
      startedAt ??= nowMs;
      const good = !emulated && hasHit;
      // Consecutive, not cumulative: a device that finds a surface once a
      // second for eight seconds has not settled, it is hunting.
      const goodFrames = good ? state.goodFrames + 1 : 0;
      const waitedMs = Math.max(0, nowMs - startedAt);
      // Once settled, stay settled. Tracking dips while the operator turns
      // away from a textured surface, and re-arming the gate mid-session would
      // take the tap away from someone who has already aimed.
      const reason: SettleReason = state.reason === 'settled' || goodFrames >= frames
        ? 'settled'
        : state.reason === 'timeout' || waitedMs >= timeoutMs ? 'timeout' : 'settling';
      state = { ready: reason !== 'settling', reason, goodFrames, emulated, hasHit, waitedMs };
      return state;
    },
  };
}
