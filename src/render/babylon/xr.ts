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
 * Start an immersive-AR session for `scene`.
 *
 * Optional features (hit-test, anchors, DOM overlay) are requested but their
 * absence never aborts the session — a headset without plane detection should
 * still enter AR, just without the reticle.
 */
export async function startImmersiveAr(scene: Scene, overlayRoot: HTMLElement, hooks: XrHooks = {}): Promise<XrController | undefined> {
  const { WebXRDefaultExperience } = await import('@babylonjs/core/XR/webXRDefaultExperience');
  const { WebXRHitTest } = await import('@babylonjs/core/XR/features/WebXRHitTest');
  const { WebXRFeatureName } = await import('@babylonjs/core/XR/webXRFeaturesManager');
  await import('@babylonjs/core/XR/features/WebXRDOMOverlay');

  // `disableDefaultUI` because the app has its own way in — Babylon's floating
  // "AR" button otherwise sits in the corner, behind our HUD, as a second
  // control nobody asked for.
  const xr = await WebXRDefaultExperience.CreateAsync(scene, {
    uiOptions: { sessionMode: 'immersive-ar', referenceSpaceType: 'local-floor' },
    disableDefaultUI: true,
    optionalFeatures: true,
    disableTeleportation: true,
  }).catch(() => undefined);
  if (!xr) return undefined;

  let reticle: Pose | undefined;
  try {
    const hitTest = xr.baseExperience.featuresManager.enableFeature(
      WebXRFeatureName.HIT_TEST,
      'latest',
    ) as InstanceType<typeof WebXRHitTest>;

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

  xr.baseExperience.onStateChangedObservable.add((state) => {
    hooks.onStateChange?.(state === WebXRState.IN_XR);
  });

  // A tap in-session drops the anchor at the current reticle.
  scene.onPointerDown = () => {
    if (xr.baseExperience.state === WebXRState.IN_XR && reticle) hooks.onSelectAnchor?.(reticle);
  };

  // Actually enter the session. Creating the experience only *prepares* one —
  // it builds the helper and, left to itself, a button for the user to press.
  // Skipping this call was the bug behind a black screen on Android: the app
  // switched into AR mode, cleared the canvas to transparent for a camera feed
  // that was never started, and rendered the assembly over the page background.
  try {
    await xr.baseExperience.enterXRAsync('immersive-ar', 'local-floor', xr.renderTarget);
  } catch (err) {
    await xr.baseExperience.exitXRAsync().catch(() => undefined);
    xr.dispose();
    return undefined;   // the caller falls back to camera passthrough
  }
  if (xr.baseExperience.state !== WebXRState.IN_XR) {
    xr.dispose();
    return undefined;
  }

  return {
    experience: xr,
    inSession: () => xr.baseExperience.state === WebXRState.IN_XR,
    end: async () => {
      await xr.baseExperience.exitXRAsync().catch(() => undefined);
    },
  };
}
