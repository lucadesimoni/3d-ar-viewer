import '@babylonjs/core/XR/webXRDefaultExperience';
import type { WebXRDefaultExperience } from '@babylonjs/core/XR/webXRDefaultExperience';
import { WebXRState } from '@babylonjs/core/XR/webXRTypes';
import type { Scene } from '@babylonjs/core/scene';
import type { Pose } from '../../engine/types';

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
export function bindXrPlacement(
  session: Pick<XRSession, 'addEventListener' | 'removeEventListener'>,
  overlayRoot: HTMLElement,
  canvas: HTMLCanvasElement | null,
  onSelect: () => void,
): () => void {
  // DOM controls still receive their normal clicks, but must not also place
  // the assembly through the touchscreen's XR input source.
  const beforeSelect = (event: Event): void => {
    if (event.target !== canvas) event.preventDefault();
  };
  session.addEventListener('select', onSelect);
  overlayRoot.addEventListener('beforexrselect', beforeSelect);
  return () => {
    session.removeEventListener('select', onSelect);
    overlayRoot.removeEventListener('beforexrselect', beforeSelect);
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
  }).catch((err) => noteXrError('creating the session', err));
  if (!xr) {
    lastXrError ??= 'creating the session — Babylon returned nothing';
    return undefined;
  }

  let reticle: Pose | undefined;
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
      if (!first) {
        reticle = undefined;
        hooks.onReticle?.(undefined);
        return;
      }
      const p = first.position;
      const r = first.rotationQuaternion;
      reticle = { position: [p.x, p.y, p.z], rotation: [r.x, r.y, r.z, r.w] };
      hooks.onReticle?.(reticle);
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
  const clearPlacement = (): void => {
    stopInput?.();
    stopInput = undefined;
    unmarkOverlay?.();
    unmarkOverlay = undefined;
    reticle = undefined;
    hooks.onReticle?.(undefined);
  };
  const sessionObserver = xr.baseExperience.sessionManager.onXRSessionInit.add((session) => {
    clearPlacement();
    unmarkOverlay = markXrOverlay(overlayRoot);
    stopInput = bindXrPlacement(session, overlayRoot, scene.getEngine().getRenderingCanvas(), () => {
      if (xr.baseExperience.state === WebXRState.IN_XR && reticle) hooks.onSelectAnchor?.(reticle);
    });
  });
  xr.baseExperience.onStateChangedObservable.add((state) => {
    if (state === WebXRState.IN_XR) {
      everEntered = true;
      hooks.onStateChange?.(true);
    } else if (state === WebXRState.NOT_IN_XR) {
      clearPlacement();
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
      clearPlacement();
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
      clearPlacement();
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
      clearPlacement();
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
