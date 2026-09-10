import '@babylonjs/core/XR/webXRDefaultExperience';
import type { WebXRDefaultExperience } from '@babylonjs/core/XR/webXRDefaultExperience';
import { WebXRState } from '@babylonjs/core/XR/webXRTypes';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { IWebXRHitResult } from '@babylonjs/core/XR/features/WebXRHitTest';
import type { Pose } from '../../engine/types';
import { createSettleTracker, type TrackingState } from '../../engine/tracking/settle';
import { logEvent } from '../../diagnostics/log';

/**
 * Babylon-native WebXR for immersive AR on devices that support it (Android
 * Chrome, Quest, Vision Pro). iOS Safari has no WebXR — that path runs the
 * camera-passthrough tracker instead — so this whole module is loaded only when
 * capability detection reports `immersive-ar`.
 *
 * On top of Babylon's default experience it wires up hit-testing (so the
 * operator taps a real surface to drop the assembly) and reports XR state
 * transitions and per-frame anchor poses back to the app.
 */

export interface XrHooks {
  onStateChange?: (inXr: boolean) => void;
  /** Pose of the surface reticle each frame, world frame. */
  onReticle?: (pose: Pose | undefined) => void;
  /** Operator selected (tapped) at this pose — the anchor drop. */
  onSelectAnchor?: (pose: Pose) => void;
  /**
   * The platform corrected where the placed spot really is.
   *
   * A pose in a reference space is a pose in a guess, and the guess is revised
   * as the device learns the room — which moves everything pinned to it. An
   * anchor is held by the platform instead, so this reports the same spot
   * where it now actually is, rather than the assembly sliding off the bench.
   */
  onAnchorPose?: (pose: Pose) => void;
  /**
   * How well the platform is tracking, and whether placement is armed yet.
   *
   * Reported whenever the answer changes, not every frame. See `settle.ts` for
   * why an unasked question cost a placement 78 cm below the floor.
   */
  onTracking?: (state: TrackingState) => void;
  /**
   * The platform handed over its real camera calibration.
   *
   * Fired when `camera-access` produces intrinsics, which is the one moment
   * this app stops guessing a focal length. Reported once, and again only if
   * the numbers change.
   */
  onCameraIntrinsics?: (intrinsics: XrCameraIntrinsics) => void;
}

export interface XrController {
  experience: WebXRDefaultExperience;
  end(): Promise<void>;
  inSession(): boolean;
}

/**
 * Why the last attempt to enter immersive AR did not.
 *
 * WebXR is the difference between an overlay that stays on the bench when you
 * walk round it and one that walks with you, so a silent fall back to the
 * camera is the most expensive silence in this app. Every failure path here
 * used to end in `catch { return undefined }`. Now the reason survives, and
 * the settings sheet shows it.
 */
export let lastXrError: string | undefined;
/** Which reference space the running session actually got. */
export let referenceSpace: string | undefined;
/** Features the browser actually granted, as reported by the session. */
export let grantedFeatures: string[] = [];
/** How the running session is tracking — undefined outside a session. */
export let tracking: TrackingState | undefined;

/**
 * Full pinhole intrinsics, when the platform hands them over.
 *
 * The app's field of view is otherwise an assumption — 60 degrees, with a slider
 * for the operator — and `estimateIntrinsics` turns that assumption into a focal
 * length. A five-degree error there is roughly a ten per cent range error, which
 * is fine for placing an overlay and not fine for saying whether a part is
 * seated. A session that grants raw camera access reports the real numbers.
 */
export interface XrCameraIntrinsics {
  /** Focal lengths in pixels. */
  ax: number;
  ay: number;
  /** Principal point in pixels. */
  u0: number;
  v0: number;
  gamma: number;
  width: number;
  height: number;
}

/**
 * Whether this session can see its own camera image, and what it says about it.
 *
 * In an ordinary immersive session the compositor owns the picture and the page
 * never sees it — which is why part inspection currently runs only in camera
 * passthrough, the one mode whose pose is weakest. The `camera-access` feature
 * is the way out, and whether a given device and browser grant it is a question
 * no amount of reading answers: it is asked for optionally and reported here.
 */
export let cameraAccess: {
  requested: boolean;
  granted: boolean;
  intrinsics?: XrCameraIntrinsics;
  error?: string;
} = { requested: false, granted: false };

/**
 * Reference spaces to try, best first, one per tap.
 *
 * `local-floor` puts the origin on the floor, which is what a placement on the
 * ground wants. A device that cannot establish one refuses rather than
 * downgrading — but an AR session measured from the headset is still real
 * positional tracking, and losing all of it over the origin's height would be
 * a poor trade.
 */
// A viewer space moves with the phone and cannot hold a world-locked assembly.
const SPACES: XRReferenceSpaceType[] = ['local-floor', 'local'];
let spaceIndex = 0;
export const clearXrError = (): void => { lastXrError = undefined; };
const noteXrError = (stage: string, err: unknown): undefined => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? 'no reason given');
  lastXrError = `${stage} — ${message}`.slice(0, 200);
  return undefined;
};


/** How long to wait for the session's first frame before giving up. */
const FIRST_FRAME_TIMEOUT_MS = 8000;

/**
 * How far below the reference floor a hit may still be a floor, metres.
 *
 * Generous: a real floor is uneven and the platform's own floor estimate is
 * worth a few centimetres of doubt. What it excludes is the metres.
 */
export const FLOOR_TOLERANCE_M = 0.35;
/** One line is enough to say the room is producing nonsense, ms. */
const IMPOSSIBLE_HIT_LOG_MS = 5000;

/**
 * How long a tap taken too early stays worth honouring, ms.
 *
 * Long enough to cover the couple of seconds a platform usually needs once a
 * surface is in view, short enough that it is still the same aim. Past it, the
 * operator has moved on, and placing would be the app acting on its own.
 */
export const PENDING_TAP_MS = 4000;

/** The parts of Babylon's experience this needs, so a fake can stand in. */
export interface StateSource {
  state: number;
  onStateChangedObservable: {
    add(cb: (state: number) => void): unknown;
    remove(observer: unknown): unknown;
  };
}

/**
 * Wait until the session is really running.
 *
 * `enterXRAsync` resolves *before* the session is in XR. Babylon says so in its
 * own source: "Wait until the first frame arrives before setting state to in
 * xr" — the state is set from a one-shot frame observer, after the promise has
 * already returned. Sampling the state immediately therefore always reads
 * ENTERING_XR, and treating that as failure tore down sessions that had in fact
 * started. That is what "ended in state 0" was: not a refusal, a session killed
 * a fraction of a second after it was granted.
 */
export function awaitInSession(
  source: StateSource, inXr: number, notInXr: number, timeoutMs = FIRST_FRAME_TIMEOUT_MS,
): Promise<boolean> {
  if (source.state === inXr) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let observer: unknown;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.onStateChangedObservable.remove(observer);
      resolve(ok);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    observer = source.onStateChangedObservable.add((state) => {
      if (state === inXr) finish(true);
      else if (state === notInXr) finish(false);
    });
  });
}

/**
 * Start an immersive-AR session for `scene`.
 *
 * Optional features (hit-test, anchors, DOM overlay) are requested but their
 * absence never aborts the session — a headset without plane detection should
 * still enter AR, just without the reticle.
 */
export interface XrPrepared {
  /** Enter the session. Call this *directly from a click handler*. */
  enter(): Promise<XrController | undefined>;
  dispose(): void;
}

/** The class the overlay root carries for as long as a session is running. */
export const XR_OVERLAY_CLASS = 'xr-session';

/**
 * Keep the page's own surfaces out of the DOM overlay.
 *
 * A DOM overlay is not a HUD layer the browser draws for us — it is the page,
 * composited over the camera, and everything in the overlay root is painted.
 * The render canvas is in there. During a session Babylon draws into the
 * session's framebuffer, not that canvas, so the canvas keeps whatever it last
 * held — the opaque studio background — and paints it, full screen, over the
 * real world. So does the passthrough video, if the camera path was running.
 *
 * The result is a black screen with a working HUD on top of it: identical, from
 * the operator's side, to a session that never started. Only the HUD belongs in
 * the overlay; the camera image and the scene come from the compositor.
 */
export function markXrOverlay(root: HTMLElement): () => void {
  root.classList.add(XR_OVERLAY_CLASS);
  return () => root.classList.remove(XR_OVERLAY_CLASS);
}

/** Real-world placement must not depend on picking a virtual mesh. */
/**
 * Which parts of the overlay swallow a tap instead of placing the assembly.
 *
 * Anything the operator can operate: the HUD's buttons, the sheets, a slider.
 * Everything else in the overlay is a window onto the real world, and a tap
 * there means "put it here".
 */
const INTERACTIVE = 'button, a[href], input, select, textarea, label, [role="button"], .ar-sheet, .panel';

/**
 * How far a finger may travel and still be a tap, in CSS pixels.
 *
 * A `select` fires when the touch ends, whatever happened in between — so a
 * swipe across the camera view reached the app as "put it here". Placement is
 * the most consequential gesture in the app and it must not happen by accident.
 * Sixteen pixels is roughly the platform's own slop for a tap.
 */
export const TAP_TRAVEL_PX = 16;
/** And how long. Past this it is a press, not a tap. */
export const TAP_HOLD_MS = 700;
/** How long after the finger lifts a gesture still explains an arriving select. */
const GESTURE_GRACE_MS = 600;

export function bindXrPlacement(
  session: Pick<XRSession, 'addEventListener' | 'removeEventListener'>,
  overlayRoot: HTMLElement,
  onSelect: () => void,
): () => void {
  /**
   * The finger's own account of the gesture the session is about to call a tap.
   *
   * `select` says a touch ended; it says nothing about whether it moved. The
   * DOM pointer events on the overlay do, and the overlay is composited by the
   * session anyway. Read at `select` time rather than at `pointerup`, because
   * the order of the two is not guaranteed and a rule that depends on it would
   * work on one device and not the next.
   */
  // `endedAt` is undefined until the finger lifts, never zero: `performance.now()`
  // is zero at load, and a falsy test here would read a gesture that ended at
  // the very start of the session as one still in progress. The same slip cost
  // `settle.ts` its timeout once already.
  let gesture: { travel: number; startedAt: number; endedAt?: number } | undefined;
  const from = { x: 0, y: 0 };
  const down = (event: PointerEvent): void => {
    from.x = event.clientX;
    from.y = event.clientY;
    gesture = { travel: 0, startedAt: performance.now() };
  };
  const move = (event: PointerEvent): void => {
    if (!gesture || gesture.endedAt !== undefined) return;
    gesture.travel = Math.max(gesture.travel, Math.hypot(event.clientX - from.x, event.clientY - from.y));
  };
  const up = (): void => {
    if (gesture && gesture.endedAt === undefined) gesture.endedAt = performance.now();
  };
  overlayRoot.addEventListener('pointerdown', down);
  overlayRoot.addEventListener('pointermove', move);
  overlayRoot.addEventListener('pointerup', up);
  overlayRoot.addEventListener('pointercancel', up);

  /** A tap, as far as the finger is concerned. Nothing known means yes. */
  const wasTap = (): boolean => {
    if (!gesture) return true;   // no pointer events in this host: fail open
    const now = performance.now();
    if (gesture.endedAt !== undefined && now - gesture.endedAt > GESTURE_GRACE_MS) return true;
    const heldMs = (gesture.endedAt ?? now) - gesture.startedAt;
    if (gesture.travel <= TAP_TRAVEL_PX && heldMs <= TAP_HOLD_MS) return true;
    logEvent('xr', 'select ignored — a swipe, not a tap', {
      travelPx: Math.round(gesture.travel), heldMs: Math.round(heldMs),
    });
    return false;
  };
  // DOM controls still receive their normal clicks, but must not also place
  // the assembly through the touchscreen's XR input source.
  //
  // This used to ask whether the tap landed on the render canvas, and let only
  // those through. That was right while the canvas was the top surface of the
  // overlay — and it stopped being right the moment the canvas was hidden so it
  // could not paint over the camera. A hidden element is never an event target,
  // so every tap looked like a tap on the chrome and every one of them was
  // cancelled: aiming at a surface and tapping did nothing at all in a session,
  // while the camera path, which does not go through `select`, kept working.
  //
  // So ask the question that was always meant: is this a control? Only a
  // control swallows the tap.
  const beforeSelect = (event: Event): void => {
    const target = event.target;
    if (target instanceof Element && target.closest(INTERACTIVE)) event.preventDefault();
  };
  const select = (): void => { if (wasTap()) onSelect(); };
  session.addEventListener('select', select);
  overlayRoot.addEventListener('beforexrselect', beforeSelect);
  return () => {
    session.removeEventListener('select', select);
    overlayRoot.removeEventListener('beforexrselect', beforeSelect);
    overlayRoot.removeEventListener('pointerdown', down);
    overlayRoot.removeEventListener('pointermove', move);
    overlayRoot.removeEventListener('pointerup', up);
    overlayRoot.removeEventListener('pointercancel', up);
  };
}

/**
 * Build the session helper without entering it.
 *
 * This split is the whole point. `requestSession('immersive-ar')` needs the
 * user activation from a tap, and an activation does not survive much: on a
 * phone, a 300 kB dynamic import and the asynchronous setup inside
 * `CreateAsync` can outlast it, and the session is then refused with no
 * explanation the operator could act on.
 *
 * It is also, exactly, what used to work. Before the app entered sessions
 * itself, `CreateAsync` ran at AR entry and Babylon's own floating button
 * called `enterXRAsync` — a click with nothing awaited in front of it. Removing
 * that button removed the one path that reliably got a real session.
 *
 * So: prepare early, enter from the click.
 */
export async function prepareImmersiveAr(
  scene: Scene, overlayRoot: HTMLElement, hooks: XrHooks = {},
): Promise<XrPrepared | undefined> {
  const { WebXRDefaultExperience } = await import('@babylonjs/core/XR/webXRDefaultExperience');
  const { WebXRHitTest } = await import('@babylonjs/core/XR/features/WebXRHitTest');
  const { WebXRAnchorSystem } = await import('@babylonjs/core/XR/features/WebXRAnchorSystem');
  const { WebXRRawCameraAccess } = await import('@babylonjs/core/XR/features/WebXRRawCameraAccess');
  const { WebXRFeatureName } = await import('@babylonjs/core/XR/webXRFeaturesManager');
  await import('@babylonjs/core/XR/features/WebXRDOMOverlay');

  // `disableDefaultUI` because the app has its own way in — Babylon's floating
  // "AR" button otherwise sits in the corner, behind our HUD, as a second
  // control nobody asked for.
  clearXrError();
  const xr = await WebXRDefaultExperience.CreateAsync(scene, {
    uiOptions: { sessionMode: 'immersive-ar', referenceSpaceType: 'local-floor' },
    disableDefaultUI: true,
    optionalFeatures: true,
    disableTeleportation: true,
    disablePointerSelection: true,
    disableNearInteraction: true,
    // No fetching controller descriptions from the open internet.
    //
    // Babylon looks every input source up in a repository hosted on
    // immersive-web.github.io — and a phone's touchscreen is an input source
    // like any other, so an AR session on a plain Android phone reaches out to
    // GitHub. On a shop floor, and on the network this app is tested from,
    // which blocks CDNs outright, that request cannot succeed. There are no
    // motion controllers here to describe: Babylon's bundled defaults are the
    // whole truth. (The static `UseOnlineRepository` looks like the switch and
    // is not — `WebXRInput`'s constructor overwrites it from this option.)
    inputOptions: { disableOnlineControllerRepository: true, doNotLoadControllerMeshes: true },
  }).catch((err) => noteXrError('creating the session', err));
  if (!xr) {
    lastXrError ??= 'creating the session — Babylon returned nothing';
    return undefined;
  }

  let reticle: Pose | undefined;
  /** The hit-test result behind the reticle, which an anchor is created from. */
  let lastHit: IWebXRHitResult | undefined;
  let anchors: InstanceType<typeof WebXRAnchorSystem> | undefined;
  /** The anchor the assembly is currently riding, if the device grants them. */
  let placedAnchorId: number | undefined;
  const settle = createSettleTracker();
  /** When the running session began, and when it first saw a surface. */
  let sessionAtMs = 0;
  let firstHitAtMs = 0;
  /** A tap taken while the floor was still being found, waiting to be honoured. */
  let pendingTapAtMs = 0;
  /**
   * Throttle for the "that is not a floor" line.
   *
   * Undefined, not zero: `performance.now()` counts from page load, so a zero
   * here means "logged at load" and swallows every message in the first five
   * seconds — which is exactly when a session starts. The same slip has now
   * cost `settle.ts` its timeout and `bindXrPlacement` its stale-gesture rule.
   */
  let impossibleHitLoggedAtMs: number | undefined;
  /**
   * Put the assembly here, and ask the platform to hold the spot.
   *
   * One path, whether the tap was acted on at once or held for a moment while
   * the floor was still being found — otherwise the held one would place
   * without an anchor and drift away from a spot the other keeps.
   */
  const place = (at: Pose): void => {
    hooks.onSelectAnchor?.(at);
    const hit = lastHit;
    if (!anchors || !hit) return;
    void anchors.addAnchorPointUsingHitTestResultAsync(hit)
      .then((anchor) => { placedAnchorId = anchor.id; })
      .catch(() => { placedAnchorId = undefined; });
  };
  /**
   * Whether frames are being sampled at all.
   *
   * The placement gate is only as good as the signal behind it. A platform that
   * does not let us watch frames gives no signal, and a gate with no signal
   * would refuse every tap for ever — so with nothing to go on, it opens.
   */
  let watchingFrames = false;
  try {
    // `required: false` — the fifth argument, and it defaults to *true*.
    //
    // Babylon adds every enabled feature to the session request, and a required
    // one that the device cannot provide makes the browser refuse the whole
    // session. Asking for hit-test with two arguments therefore said "no AR at
    // all unless this phone can do surface detection", and on Android that
    // depends on Google Play Services for AR being installed and current. The
    // session was refused, the app fell back to the camera, and what the
    // operator saw was an overlay that would not stay on the bench.
    //
    // Hit-test is worth having and not worth losing a session over: without it
    // the app still places by tap on its own estimated plane, which is what the
    // camera path does anyway.
    const hitTest = xr.baseExperience.featuresManager.enableFeature(
      WebXRFeatureName.HIT_TEST, 'latest', {}, true, false,
    ) as InstanceType<typeof WebXRHitTest>;
    hitTest.autoCloneTransformation = true;

    hitTest.onHitTestResultObservable.add((results) => {
      const first = results[0];
      // A surface below the floor is not a surface.
      //
      // In a `local-floor` session y = 0 is the floor, and a device log has
      // three floor placements at −0.47, −2.92 and +0.05 with the phone held
      // around a metre up. Two of the three were metres underground, and the
      // anchors made on them then wandered by as much as 4.2 m, because they
      // were pinned to nothing. The third, the one at +0.05, was the floor.
      // The platform is entitled to be unsure; it is not entitled to be
      // believed about a floor beneath the floor.
      const below = Boolean(first) && referenceSpace === 'local-floor'
        && first.position.y < -FLOOR_TOLERANCE_M;
      if (below && (impossibleHitLoggedAtMs === undefined
        || performance.now() - impossibleHitLoggedAtMs > IMPOSSIBLE_HIT_LOG_MS)) {
        impossibleHitLoggedAtMs = performance.now();
        logEvent('xr', 'hit-test result below the floor, refused', {
          y: Number(first.position.y.toFixed(3)),
          toleranceM: FLOOR_TOLERANCE_M,
        });
      }
      if (!first || below) {
        reticle = undefined;
        lastHit = undefined;
        hooks.onReticle?.(undefined);
        return;
      }
      // The first surface of each session, once, with how long it took.
      //
      // A device log has a second session in the same page load waiting 20
      // seconds for a surface where the first waited three. That is either the
      // room or a hit-test source that did not come back with the new session,
      // and the two readings are indistinguishable without this line.
      if (!firstHitAtMs) {
        firstHitAtMs = performance.now();
        logEvent('xr', 'first surface found', {
          waitedMs: Math.round(firstHitAtMs - (sessionAtMs || firstHitAtMs)),
          attached: hitTest.attached,
        });
      }
      const p = first.position;
      const r = first.rotationQuaternion;
      lastHit = first;
      reticle = { position: [p.x, p.y, p.z], rotation: [r.x, r.y, r.z, r.w] };
      hooks.onReticle?.(reticle);
    });

    // Is the platform tracking yet, or still guessing?
    //
    // `emulatedPosition` is the question WebXR answers for nothing, and not
    // asking it cost a real placement 78 cm below the floor (see `settle.ts`).
    // Paired with "the hit-test is returning a surface" over a run of frames it
    // says when a tap is worth acting on.
    xr.baseExperience.sessionManager.onXRFrameObservable.add((frame) => {
      const space = xr.baseExperience.sessionManager.referenceSpace;
      let emulated = true;
      try {
        // A frame can refuse a pose entirely while the device is lost, which is
        // the same answer as an emulated one: not yet.
        emulated = space ? (frame.getViewerPose(space)?.emulatedPosition ?? true) : true;
      } catch {
        emulated = true;
      }
      const before = tracking;
      const now = settle.sample({ emulated, hasHit: Boolean(reticle) }, performance.now());
      tracking = now;
      // A tap that arrived a moment too early, honoured as soon as it can be.
      // Only for as long as the operator is plausibly still aiming at the same
      // place: after that it is a tap they have given up on, and placing then
      // would be the app acting on its own.
      if (pendingTapAtMs && now.ready && reticle) {
        const held = performance.now() - pendingTapAtMs;
        pendingTapAtMs = 0;
        if (held <= PENDING_TAP_MS) {
          logEvent('place', 'held tap placed once the floor was found', { heldMs: Math.round(held) });
          place(reticle);
        }
      }
      // The first sample counts as a change. Without it the HUD would sit on
      // "tap to place" through the whole settling period, inviting exactly the
      // tap the gate is about to swallow, and say nothing about why.
      if (!before || now.reason !== before.reason || now.ready !== before.ready) {
        logEvent('xr', `tracking ${now.reason}`, {
          waitedMs: Math.round(now.waitedMs), emulated: now.emulated, hasHit: now.hasHit,
          // Whether the platform is even being asked. A session whose hit-test
          // never re-attached looks exactly like a room with no surfaces.
          hitTest: hitTest.attached,
        });
        hooks.onTracking?.(now);
      }
    });
    // After the subscription, never before: a throw here must leave the gate
    // open rather than latch it shut on a signal that will never arrive.
    watchingFrames = true;

    // Raw camera access: the frames part inspection needs, in the mode whose
    // pose is worth inspecting against.
    //
    // Optional, and emphatically so — this is the fifth argument again. A
    // session refused because the phone cannot hand over camera frames would
    // trade the whole of AR for a feature nothing yet depends on. What it
    // buys when granted is two things at once: the camera image inside the
    // session, and the real intrinsics instead of an assumed 60-degree field
    // of view.
    cameraAccess = { requested: true, granted: false };
    try {
      const raw = xr.baseExperience.featuresManager.enableFeature(
        WebXRFeatureName.RAW_CAMERA_ACCESS, 'latest', {}, true, false,
      ) as InstanceType<typeof WebXRRawCameraAccess>;
      raw.onTexturesUpdatedObservable.add(() => {
        const first = raw.cameraIntrinsics?.[0];
        const measured = first ? {
          ax: first.ax, ay: first.ay, u0: first.u0, v0: first.v0,
          gamma: first.gamma, width: first.width, height: first.height,
        } : undefined;
        const changed = measured && (
          measured.ax !== cameraAccess.intrinsics?.ax
          || measured.ay !== cameraAccess.intrinsics?.ay
          || measured.width !== cameraAccess.intrinsics?.width
          || measured.height !== cameraAccess.intrinsics?.height
        );
        cameraAccess = {
          requested: true,
          granted: true,
          ...(measured ? { intrinsics: measured } : {}),
        };
        // Every frame carries these; only a change is worth telling anyone.
        if (measured && changed) {
          logEvent('xr', 'camera intrinsics granted', {
            fovDeg: Number(((2 * Math.atan(measured.height / 2 / measured.ay) * 180) / Math.PI).toFixed(2)),
            size: [measured.width, measured.height],
          });
          hooks.onCameraIntrinsics?.(measured);
        }
      });
    } catch (err) {
      cameraAccess = {
        requested: true,
        granted: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }

    // Anchors: the answer to an assembly that drifts off the bench.
    //
    // A pose in a reference space is a pose in a *guess* — ARCore refines its
    // idea of the room continuously, and every refinement moves the whole space
    // under anything pinned to it. That is the hopping and drifting seen even
    // in Babylon's own AR sample, which does exactly this. An anchor is the
    // other way round: the platform is told "this spot on this surface", and it
    // carries the spot along when it corrects itself. Optional, because a
    // device without it still places — it just places into a space that moves.
    anchors = xr.baseExperience.featuresManager.enableFeature(
      WebXRFeatureName.ANCHOR_SYSTEM, 'latest', {}, true, false,
    ) as InstanceType<typeof WebXRAnchorSystem>;
    anchors.onAnchorUpdatedObservable.add((anchor) => {
      if (anchor.id !== placedAnchorId) return;
      const position = new Vector3();
      const rotation = new Quaternion();
      if (!anchor.transformationMatrix.decompose(undefined, rotation, position)) return;
      hooks.onAnchorPose?.({
        position: [position.x, position.y, position.z],
        rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
      });
    });
  } catch {
    // Hit-test unsupported on this device; the app falls back to manual placement.
  }

  // The HUD is ordinary DOM, and an immersive session hides the page unless the
  // session is told to composite an element over the camera. Without this the
  // operator gets the overlay and no controls at all.
  try {
    xr.baseExperience.featuresManager.enableFeature(
      WebXRFeatureName.DOM_OVERLAY, 'latest', { element: overlayRoot }, false, false,
    );
  } catch {
    // Not supported (or the element is unsuitable) — the session still runs.
  }

  // Only a session that actually ran can end.
  //
  // Babylon reports the state falling back to NOT_IN_XR when an *attempt*
  // fails, and again when the helper is disposed. Forwarding those as "the
  // session ended" made a refused attempt tear the whole AR mode down: press
  // "Try real AR tracking", the request is denied, and the operator is thrown
  // out of the camera passthrough they were already using. A failed entry has
  // to leave everything exactly as it found it.
  let everEntered = false;
  let stopInput: (() => void) | undefined;
  let unmarkOverlay: (() => void) | undefined;
  /**
   * `starting` distinguishes a new session from a finished one.
   *
   * The tracking state is reset for a session that is beginning and *kept* for
   * one that has ended. An iPad log came back from inside the App Clip saying
   * `settling, waitedMs: 41` for a session that had run four and a half
   * seconds — because the state was cleared on the way out and the report fell
   * back to the last reported *change*, which was the first frame. The one
   * question that log was taken to answer went unanswered.
   */
  const clearPlacement = (starting: boolean): void => {
    pendingTapAtMs = 0;
    if (starting) {
      sessionAtMs = performance.now();
      firstHitAtMs = 0;
      settle.reset(sessionAtMs);
      tracking = undefined;
    }
    placedAnchorId = undefined;
    lastHit = undefined;
    stopInput?.();
    stopInput = undefined;
    unmarkOverlay?.();
    unmarkOverlay = undefined;
    reticle = undefined;
    hooks.onReticle?.(undefined);
  };
  const sessionObserver = xr.baseExperience.sessionManager.onXRSessionInit.add((session) => {
    clearPlacement(true);
    unmarkOverlay = markXrOverlay(overlayRoot);
    stopInput = bindXrPlacement(session, overlayRoot, () => {
      if (xr.baseExperience.state !== WebXRState.IN_XR || !reticle) return;
      // Not before the platform knows where the floor is — but not thrown away
      // either. A device log has a tap refused at 22 of the 30 frames it takes
      // to settle, two tenths of a second before it would have been taken: the
      // operator was aiming at the right spot and got nothing, and had to
      // notice that and do it again. The tap is remembered instead, and the
      // placement happens the moment the floor is there.
      if (watchingFrames && !settle.state().ready) {
        pendingTapAtMs = performance.now();
        logEvent('xr', 'tap held — still finding the floor', {
          goodFrames: settle.state().goodFrames,
          waitedMs: Math.round(settle.state().waitedMs),
        });
        return;
      }
      pendingTapAtMs = 0;
      place(reticle);
    });
  });
  xr.baseExperience.onStateChangedObservable.add((state) => {
    if (state === WebXRState.IN_XR) {
      everEntered = true;
      hooks.onStateChange?.(true);
    } else if (state === WebXRState.NOT_IN_XR) {
      // Ending, not starting: what the session ended up doing is exactly what
      // the report written afterwards is for.
      clearPlacement(false);
      if (!everEntered) return;
      everEntered = false;
      hooks.onStateChange?.(false);
    }
  });

  const enter = async (): Promise<XrController | undefined> => {
    // One `requestSession` per tap. Exactly one.
    //
    // My first version tried three reference spaces in a loop, and that was
    // worse than useless: `requestSession` *consumes* the transient user
    // activation, so the second and third calls fail with "requires user
    // activation" whatever the truth was — and reporting the last error buried
    // the first, which is the only one that says anything. A device reported
    // `entering the session (viewer) — SecurityError: requires user activation`
    // and the real reason had been thrown away two rungs earlier.
    //
    // So the ladder is climbed across *taps* instead: this attempt uses the
    // best space not yet ruled out, and a failure that is not about activation
    // rules it out for the next one.
    const space = SPACES[Math.min(spaceIndex, SPACES.length - 1)];
    try {
      // Babylon silently substitutes a head-relative viewer space when an
      // optional space is refused. Require this space so AR cannot appear to
      // succeed with anchors that follow the phone.
      await xr.baseExperience.enterXRAsync('immersive-ar', space, xr.renderTarget, {
        requiredFeatures: [space],
      });
    } catch (err) {
      noteXrError(`entering the session (${space})`, err);
      const activation = /user activation/i.test(lastXrError ?? '');
      // An activation failure says nothing about the reference space, so it
      // must not cost us one. Anything else did rule this space out.
      if (!activation && spaceIndex < SPACES.length - 1) spaceIndex++;
      await xr.baseExperience.exitXRAsync().catch(() => undefined);
      clearPlacement(false);
      return undefined;
    }
    // The promise above resolves before the session is in XR — see
    // `awaitInSession`. Give it until its first frame.
    const running = await awaitInSession(
      xr.baseExperience as unknown as StateSource, WebXRState.IN_XR, WebXRState.NOT_IN_XR,
    );
    if (!running) {
      // No advance of the reference-space ladder here. A session that was
      // granted and then produced no frame says nothing about the space it was
      // measured in — `setReferenceSpaceTypeAsync` throws for one it cannot
      // provide, and that lands in the catch above. Ruling out `local-floor`
      // on this evidence is how the ladder walked itself down to `viewer` for
      // a fault that had nothing to do with either.
      lastXrError = `entering the session (${space}) — no first frame, state ${xr.baseExperience.state}`;
      await xr.baseExperience.exitXRAsync().catch(() => undefined);
      clearPlacement(false);
      return undefined;
    }
    clearXrError();
    referenceSpace = space;
    const session = xr.baseExperience.sessionManager.session as XRSession & {
      enabledFeatures?: string[];
    };
    grantedFeatures = [...(session?.enabledFeatures ?? [])];
    return {
      experience: xr,
      end: async () => { await xr.baseExperience.exitXRAsync().catch(() => undefined); },
      inSession: () => xr.baseExperience.state === WebXRState.IN_XR,
    };
  };

  return {
    enter,
    dispose: () => {
      clearPlacement(false);
      xr.baseExperience.sessionManager.onXRSessionInit.remove(sessionObserver);
      xr.dispose();
    },
  };
}

/** Prepare and enter in one call, for callers already inside a gesture. */
export async function startImmersiveAr(
  scene: Scene, overlayRoot: HTMLElement, hooks: XrHooks = {},
): Promise<XrController | undefined> {
  const prepared = await prepareImmersiveAr(scene, overlayRoot, hooks);
  if (!prepared) return undefined;
  const controller = await prepared.enter();
  if (!controller) prepared.dispose();
  return controller;
}
