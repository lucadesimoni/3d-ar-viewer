import { useCallback, useEffect, useRef, useState } from 'react';
import { detectCapabilities, type Capabilities } from '../engine/tracking/capabilities';
import { CameraTracker } from '../engine/tracking/cameraTracker';
import { MarkerTracker } from '../engine/tracking/markerTracking';
import { RecognitionPipeline, type PipelineConfig, type PipelineStatus } from '../vision/pipeline';
import { envModelConfig } from '../vision/defaultModels';
import { classifyRecognition, type LabelInfo } from '../vision/verdict';
import { ObjectAnchorTracker } from '../vision/objectAnchor';
import { detectPerfProfile } from '../render/perf';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { toImageData } from '../vision/opencv';
import { alignToMarker } from '../engine/alignment';
import { useStore, surfaceDrop } from '../state/store';
import type { GridTargetDef } from '../engine/types';
import type { SceneManager } from '../render/babylon/SceneManager';
import { logEvent } from '../diagnostics/log';

/**
 * Orchestrates the whole AR runtime for the current device.
 *
 * The anchoring strategy, in the order the app tries it:
 *
 *  1. **WebXR hit-test** — a real plane reported by the device. The reticle sits
 *     on the actual floor and the anchor is world-locked, so the operator can
 *     walk around the assembly. Android, Quest, Vision Pro.
 *  2. **Object recognition, then tracking** — the assembly's own facade, found
 *     in the camera frame by `vision/gridRecognition` and thereafter *followed*
 *     frame by frame by `vision/objectAnchor`. Detection alone updates once or
 *     twice a second, which leaves the overlay standing still while the operator
 *     moves; tracking closes that gap and is the nearest thing to ARKit's world
 *     tracking that Safari allows. Every part hangs off `assemblyRoot`, so one
 *     pose carries the whole build with it.
 *  3. **Fiducial marker** — a printed QR of known size, when the assembly ships
 *     with one. Most precise, but it has to be there.
 *  4. **Aim-and-tap on the estimated floor** — iOS Safari has no WebXR, but
 *     gravity plus an assumed eye height defines the ground plane well enough to
 *     place the assembly at a true distance where the operator points.
 *
 * What it no longer does is drop the model at a guessed standoff in front of the
 * camera and call that a placement.
 */

/** Fall back to a floating preview if nothing has been placed by then, ms. */
const PREVIEW_FALLBACK_MS = 6000;
/** Width the camera frame is sampled at for recognition and tracking. */
const FRAME_WIDTH = 480;

/** The slice of the Screen Wake Lock API used here; not in every lib.dom yet. */
interface WakeLock { released: boolean; release(): Promise<void> }
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeLock> };
};

/**
 * Hand the camera back to the operating system.
 *
 * Stopping the tracks is not enough on its own: the `<video>` element keeps a
 * reference to the stream, and on Android that is enough for the next
 * `getUserMedia` to come back `NotReadableError: Could not start video source`
 * — the camera looks busy because, as far as the platform is concerned, this
 * page is still holding it. Detach the element too.
 */
function releaseVideo(video: HTMLVideoElement | null): void {
  if (!video) return;
  const stream = video.srcObject as MediaStream | null;
  for (const track of stream?.getTracks() ?? []) {
    try { track.stop(); } catch { /* already gone */ }
  }
  video.pause();
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
}

/**
 * Hold the screen awake for the duration of an AR session.
 *
 * Guided assembly is exactly the case where the operator's hands are busy and
 * they are not touching the screen: the display dims mid-step, the camera feed
 * stops, and the anchor is lost. The lock is dropped by the browser whenever the
 * page is hidden, so it has to be taken again on the way back.
 */
async function takeWakeLock(): Promise<WakeLock | undefined> {
  const nav = typeof navigator !== 'undefined' ? (navigator as WakeLockNavigator) : undefined;
  if (!nav?.wakeLock) return undefined;
  try {
    return await nav.wakeLock.request('screen');
  } catch {
    return undefined;   // denied, or the tab is not visible
  }
}

export function useArController(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  recognitionConfig?: PipelineConfig,
) {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>();
  const [arActive, setArActive] = useState(false);
  const trackerRef = useRef<CameraTracker | undefined>(undefined);
  const markerRef = useRef<MarkerTracker | undefined>(undefined);
  const pipelineRef = useRef<RecognitionPipeline | undefined>(undefined);
  const recognitionGeneration = useRef(0);
  const sessionGeneration = useRef(0);
  const entryPending = useRef(false);
  const retryPending = useRef(false);
  const frameTimer = useRef<number | undefined>(undefined);
  const previewTimer = useRef<number | undefined>(undefined);
  const stopPlacement = useRef<(() => void) | undefined>(undefined);
  const xrSession = useRef<{ end: () => Promise<void> } | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);
  const wakeLock = useRef<WakeLock | undefined>(undefined);
  const cameraSuspended = useRef(false);
  const objectAnchor = useRef<ObjectAnchorTracker | undefined>(undefined);
  const videoGeometryCleanup = useRef<(() => void) | undefined>(undefined);

  const setAnchor = useStore((s) => s.setAnchor);
  const assembly = useStore((s) => s.assembly);
  const setArMode = useStore((s) => s.setArMode);

  // Recognition is temporally smoothed; a step change means a different expected
  // part, so clear the tracker/voter history rather than carrying stale votes.
  const activeStepId = useStore((s) => s.activeStepId);
  useEffect(() => {
    recognitionGeneration.current++;
    pipelineRef.current?.resetTemporal();
    useStore.getState().setRecognition(undefined);
  }, [activeStepId, assembly]);

  useEffect(() => {
    if (!trackerRef.current) return;
    objectAnchor.current = assembly.recognition
      ? new ObjectAnchorTracker(assembly.recognition, { detectIntervalMs: detectPerfProfile().recognitionIntervalMs })
      : undefined;
  }, [assembly]);

  useEffect(() => {
    const video = videoRef.current;
    const definition = assembly.marker;
    if (!arActive || !trackerRef.current || xrSession.current || !video || !definition) return;
    const marker = new MarkerTracker(definition.sizeM, (obs) => {
      if (markerRef.current !== marker || xrSession.current || cameraSuspended.current
        || !trackerRef.current?.state.running || useStore.getState().assembly !== assembly) return;
      if (obs.id !== definition.id) return;
      const world = getActiveManager()?.cameraToWorld(obs.pose) ?? obs.pose;
      const anchor = alignToMarker(world, definition.poseInAssembly);
      const quality = Math.max(0, Math.min(1, 1 - obs.reprojectionPx / 8));
      setAnchor(anchor, quality, 'marker');
      stopPlacement.current?.();
      stopPlacement.current = undefined;
      trackerRef.current.markRegistered();
    });
    markerRef.current = marker;
    marker.start(video);
    return () => {
      marker.stop();
      if (markerRef.current === marker) markerRef.current = undefined;
    };
  }, [assembly, arActive, videoRef, setAnchor]);

  // A host can replace this immutable configuration without restarting its
  // camera/XR session. Cleanup owns both loaded and still-loading models.
  useEffect(() => {
    let alive = true;
    recognitionGeneration.current++;
    setPipelineStatus(undefined);
    useStore.getState().setRecognition(undefined);
    const pipeline = new RecognitionPipeline(recognitionConfig ?? envModelConfig());
    pipelineRef.current = pipeline;
    void pipeline.init().then((status) => {
      if (alive) setPipelineStatus(status);
    });
    return () => {
      alive = false;
      recognitionGeneration.current++;
      pipeline.dispose();
      if (pipelineRef.current === pipeline) pipelineRef.current = undefined;
    };
  }, [recognitionConfig]);

  useEffect(() => {
    let alive = true;
    detectCapabilities().then((caps) => {
      if (!alive) return;
      setCapabilities(caps);
      setArMode(caps.recommended);
      // Requesting an XR session needs the user's click to still be "fresh".
      // Loading 300 kB of WebXR code first can spend that activation, so pull
      // the module in now, while nobody is waiting for it.
      // Preload for *any* browser that has WebXR, not only one whose probe said
      // yes: entering a session needs the tap's user activation, and 300 kB of
      // download inside the tap handler is how that activation gets spent. The
      // session helper is built ahead of time for the same reason — that split
      // is what Babylon's own AR button used to give us for free.
      if (caps.webxrSupported && caps.permissionsPolicy?.['xr-spatial-tracking'] !== 'denied') {
        void import('../render/babylon/xr');
        void getActiveManager()?.prepareWebXr({
          onPlace: (pose) => { if (xrSession.current) useStore.getState().setAnchor(pose, 0.9, 'floor'); },
          onEnd: () => { if (xrSession.current) stop(); },
        });
      }
    });
    return () => { alive = false; };
  }, [setArMode]);

  const stop = useCallback(() => {
    // Leaving AR must be unconditional. Every step below is something that can
    // throw on some device — a wake lock already released, an XR session that
    // ended itself, a camera the OS took away — and one throw used to abort the
    // rest, leaving the app convinced it was still in AR with a dead camera and
    // an Exit button that did nothing.
    const safely = (label: string, fn: () => void): void => {
      try { fn(); } catch (err) { console.warn(`AR teardown: ${label} failed`, err); }
    };

    setArActive(false);
    sessionGeneration.current++;
    entryPending.current = false;
    retryPending.current = false;
    recognitionGeneration.current++;
    safely('recognition', () => pipelineRef.current?.resetTemporal());
    safely('frame loop', () => {
      if (frameTimer.current) window.clearInterval(frameTimer.current);
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
      objectAnchor.current = undefined;
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
    });
    safely('placement', () => { stopPlacement.current?.(); stopPlacement.current = undefined; });
    safely('video geometry', () => { videoGeometryCleanup.current?.(); videoGeometryCleanup.current = undefined; });
    safely('xr session', () => { void xrSession.current?.end(); xrSession.current = undefined; });
    safely('wake lock', () => { void wakeLock.current?.release().catch(() => undefined); wakeLock.current = undefined; });
    safely('marker tracker', () => markerRef.current?.stop());
    safely('camera tracker', () => trackerRef.current?.stop());
    safely('camera element', () => releaseVideo(videoRef.current));
    safely('scene', () => getActiveManager()?.setArMode(false));
    trackerRef.current = undefined;
    markerRef.current = undefined;
    cameraSuspended.current = false;

    const store = useStore.getState();
    store.setRecognition(undefined);
    store.setArPlacement('idle');
    store.setArSource(undefined);
    store.setArMotion(false);
  }, [videoRef]);

  useEffect(() => {
    sessionGeneration.current++;
    retryPending.current = false;
    // Keep an established session across recognition/assembly updates, but
    // cancel permission prompts and starts that belonged to the old context.
    if (entryPending.current || (trackerRef.current && !trackerRef.current.state.running)) stop();
  }, [assembly, recognitionConfig, stop]);

  /**
   * Bring the camera up and wire it to the scene. Used both when entering AR
   * and when resuming a session that was suspended while the tab was in the
   * background, so the two cannot drift apart.
   */
  const startCamera = useCallback(async (
    video: HTMLVideoElement,
    generation = sessionGeneration.current,
  ): Promise<boolean> => {
    if (capabilities?.permissionsPolicy?.camera === 'denied') {
      useStore.getState().setArError('Camera is blocked by embedding policy. Ask the host to allow camera access in its iframe and Permissions-Policy header, or use the 3D preview.');
      return false;
    }
    if (generation !== sessionGeneration.current) return false;
    const startAssembly = useStore.getState().assembly;
    const tracker = new CameraTracker();
    trackerRef.current?.stop();
    trackerRef.current = tracker;
    await tracker.start(video);
    if (generation !== sessionGeneration.current || trackerRef.current !== tracker
      || useStore.getState().assembly !== startAssembly) {
      tracker.stop();
      if (trackerRef.current === tracker) trackerRef.current = undefined;
      return false;
    }
    if (tracker.state.error) {
      // Say what happened. Doing nothing at all was indistinguishable from a
      // broken build, and the commonest causes are things the operator can fix
      // in two taps once they know what is being asked.
      useStore.getState().setArError(tracker.state.error);
      tracker.stop();
      trackerRef.current = undefined;
      return false;
    }
    if (!tracker.state.running) {
      tracker.stop();
      trackerRef.current = undefined;
      return false;
    }
    useStore.getState().setArError(undefined);

    const manager = getActiveManager();
    // Tell the scene the camera image's shape so the overlay is drawn at the
    // field of view actually visible after `object-fit: cover` crops it. On a
    // tablet in landscape a 4:3 frame loses ~7% of its height, and rendering at
    // the uncropped FOV makes the whole overlay that much too small.
    const publishGeometry = (): void => {
      if (video.videoWidth > 0) {
        manager?.setPassthroughSource(
          video.videoWidth, video.videoHeight,
          useStore.getState().arSettings.cameraFovDeg,
        );
      }
    };
    publishGeometry();
    video.addEventListener('loadedmetadata', publishGeometry);
    videoGeometryCleanup.current?.();
    videoGeometryCleanup.current = () => video.removeEventListener('loadedmetadata', publishGeometry);

    tracker.subscribe((st) => {
      if (trackerRef.current !== tracker) return;
      getActiveManager()?.setDeviceOrientation(st.orientation);
      useStore.getState().setArMotion(st.receivingMotion);
    });
    return true;
  }, [capabilities]);

  /**
   * Take a granted session and make it the app's only source of pose.
   *
   * There were two of these — one for entering AR, one for the retry from
   * inside camera passthrough — and they had drifted apart: the retry tore down
   * the camera path and reset the store, the entry did not, and only the entry
   * held the wake lock. Two ways in that behave differently is two things to
   * debug from one report. This is the only one, and the camera teardown in it
   * is a no-op when the camera path never ran.
   */
  const startXr = useCallback(async (
    manager: SceneManager, current: () => boolean,
  ): Promise<boolean> => {
    let owned: { end: () => Promise<void> } | undefined;
    // Until the session is ours, "ours" means the entry attempt is still current.
    const owns = () => (owned ? xrSession.current === owned : current());
    const session = await manager.startWebXr(
      (pose) => { if (owns()) useStore.getState().setAnchor(pose, 0.9, 'floor'); },
      // Leaving the session (the system back gesture, the headset's own exit)
      // has to take the app out of AR too, or the UI claims to be in a session
      // that ended.
      () => { if (owns()) stop(); },
    );
    if (!current()) {
      void session?.end().catch(() => undefined);
      return false;
    }
    if (!session) {
      // Why, for the log — and never at the cost of the fallback. This runs on
      // the path where AR is about to hand over to camera passthrough, so a
      // manager that cannot answer must not take the camera down with it.
      void Promise.resolve(manager.xrFailure?.())
        .then((why) => logEvent('xr', 'no session', { why }))
        .catch(() => logEvent('xr', 'no session', {}));
      return false;
    }
    logEvent('xr', 'session granted');
    owned = session;

    // Stop every producer of camera-space poses before accepting XR poses. In
    // particular, ground placement owns its own reticle observer and the
    // preview timer can otherwise drop an anchor during XR surface detection.
    recognitionGeneration.current++;
    pipelineRef.current?.resetTemporal();
    stopPlacement.current?.();
    stopPlacement.current = undefined;
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewTimer.current = undefined;
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    rafRef.current = undefined;
    objectAnchor.current = undefined;
    markerRef.current?.stop();
    markerRef.current = undefined;
    videoGeometryCleanup.current?.();
    videoGeometryCleanup.current = undefined;
    trackerRef.current?.stop();
    trackerRef.current = undefined;
    releaseVideo(videoRef.current);
    cameraSuspended.current = false;

    xrSession.current = session;
    const store = useStore.getState();
    store.setRecognition(undefined);
    store.setArMotion(false);
    store.setArSource('webxr');
    // Camera fallback coordinates have no relationship to the new XR origin.
    store.setAnchor(undefined, 0, 'awaiting');
    armPlacement(manager, 'webxr');
    setArActive(true);

    const lock = await takeWakeLock();
    if (current()) wakeLock.current = lock;
    else void lock?.release().catch(() => undefined);
    return true;
  }, [stop, videoRef]);

  const enterAr = useCallback(async () => {
    if (arActive || entryPending.current) { stop(); return; }
    const store = useStore.getState();
    store.setArError(undefined);
    if (!capabilities) {
      store.setArError('Still checking what this device can do — try again in a moment.');
      return;
    }
    if (!capabilities.secureContext) {
      store.setArError('AR needs HTTPS. Open this page over a secure connection.');
      return;
    }
    const generation = ++sessionGeneration.current;
    entryPending.current = true;
    const current = () => generation === sessionGeneration.current && useStore.getState().assembly === assembly;
    try {
    const manager = getActiveManager();

    // 1. A device with real AR: let WebXR find the floor and place on a tap.
    //
    // Attempted whenever the browser has `navigator.xr` at all, not only when
    // `isSessionSupported('immersive-ar')` said yes. That probe runs at page
    // load, before any gesture, and on Android it answers for the state of
    // Google Play Services for AR at that moment — requesting a session is
    // what prompts the user to install it. Taking its "no" as final means a
    // phone that could do real six-degree tracking silently gets an overlay
    // that walks along with the operator. The attempt costs a moment and falls
    // through on failure, which the camera path handles anyway.
    const xrDenied = capabilities.permissionsPolicy?.['xr-spatial-tracking'] === 'denied';
    if ((capabilities.immersiveAr || capabilities.webxrSupported) && !xrDenied && manager) {
      if (await startXr(manager, current)) return;
      // The session was refused or could not be entered — fall through to
      // camera passthrough rather than leaving a transparent canvas over a
      // black page, which is what "AR" looked like before this fell through.
    }

    const video = videoRef.current;
    if (!video) {
      store.setArError('The camera surface is missing — reload the page.');
      return;
    }
    if (capabilities.permissionsPolicy?.camera === 'denied') {
      store.setArError('Camera is blocked by embedding policy. Ask the host to allow camera access in its iframe and Permissions-Policy header, or use the 3D preview.');
      return;
    }
    if (!capabilities.camera) {
      store.setArError('This browser exposes no camera. AR falls back to the 3D preview.');
      return;
    }

    // iOS gates motion behind a user gesture — this call is inside the click.
    if (capabilities.motionNeedsPermission) await CameraTracker.requestMotionPermission();
    if (!current()) return;

    const lock = await takeWakeLock();
    if (!current()) {
      void lock?.release().catch(() => undefined);
      return;
    }
    wakeLock.current = lock;

    if (!(await startCamera(video, generation)) || !current()) {
      if (generation === sessionGeneration.current) stop();
      return;
    }
    if (xrDenied) {
      useStore.getState().setArError('World-tracked AR is blocked by embedding policy. Using camera preview; the host must allow xr-spatial-tracking for WebXR.');
    }
    useStore.getState().setArSource('camera');
    logEvent('ar', 'camera passthrough running', { video: [video.videoWidth, video.videoHeight] });
    setArActive(true);

    // Put the 3D scene into AR: transparent clear, head camera, orbit controls
    // off — the camera itself is driven from the device's orientation inside
    // `startCamera`, which is also what resuming after a tab switch replays.
    manager?.setArMode(true);

    // 4. Aim at the floor and tap. The reticle follows the ground plane implied
    // by gravity and eye height, so the tap lands at a real distance.
    if (manager && armPlacement(manager, 'camera')) {
      stopPlacement.current = manager.startGroundPlacement(
        surfaceDrop(useStore.getState().arSettings),
        (pose) => {
          useStore.getState().setAnchor(pose, 0.6, 'floor');
          stopPlacement.current = undefined;
        },
        { floorIsGuesswork: () => !useStore.getState().arMotion },
      );
      // Safety net: if they have not placed it and nothing has been recognised,
      // show the assembly in front of them so the screen is not empty. Aiming
      // and tapping still re-places it properly.
      previewTimer.current = window.setTimeout(() => {
        if (!useStore.getState().anchor) {
          useStore.getState().setAnchor(manager.computeAnchorInFront(), 0.2, 'awaiting');
        }
      }, PREVIEW_FALLBACK_MS);

    }

    // Frame loop. Two jobs at two very different rates, driven off one capture:
    // the object anchor runs as fast as the device can take it, because that is
    // what makes the overlay follow the operator, while the CV/ML pipeline stays
    // on its slow interval because it is comparatively enormous.
    const perf = detectPerfProfile();
    const trackIntervalMs = Math.max(30, Math.round(2000 / perf.targetFps));
    objectAnchor.current = assembly.recognition
      ? new ObjectAnchorTracker(assembly.recognition, { detectIntervalMs: perf.recognitionIntervalMs })
      : undefined;

    let lastTrack = 0;
    let lastPipeline = 0;
    let busyPipeline: RecognitionPipeline | undefined;

    const loop = (now: number): void => {
      rafRef.current = requestAnimationFrame(loop);
      if (video.readyState < 2 || !trackerRef.current || cameraSuspended.current || xrSession.current) return;
      const frameState = useStore.getState();
      const anchorDue = objectAnchor.current !== undefined && now - lastTrack >= trackIntervalMs;
      // No part-recognition model, no part recognition. Nothing is bundled and
      // nothing is fine-tuned on these parts, so unless a deployment supplies
      // VITE_DETECTOR_MODEL_URL there is no detector — and running the frame
      // through an empty pipeline only produced an empty result, which the
      // banner then reported as "Looking for Base plate…" forever. Claiming to
      // search for something that can never be found is worse than silence.
      const pipeline = pipelineRef.current;
      const canRecognize = pipeline !== undefined && pipeline.status().detector;
      // A replaced pipeline must not wait for inference on the disposed model.
      const pipelineDue = canRecognize && busyPipeline !== pipeline
        && now - lastPipeline >= perf.recognitionIntervalMs;
      if (!anchorDue && !pipelineDue) return;

      const height = Math.round((FRAME_WIDTH * video.videoHeight) / (video.videoWidth || 640));
      const image = toImageData(video, FRAME_WIDTH, height);
      if (!image) return;

      if (anchorDue) {
        lastTrack = now;
        if (useStore.getState().arSettings.autoRecognize) {
          const target = frameState.assembly.recognition;
          const anchored = target && applyObjectAnchor(objectAnchor.current!, image, now, manager, target);
          if (anchored) {
            stopPlacement.current?.();
            stopPlacement.current = undefined;
            if (previewTimer.current) window.clearTimeout(previewTimer.current);
          }
        } else {
          objectAnchor.current!.reset();
        }
      }

      if (pipelineDue) {
        lastPipeline = now;
        busyPipeline = pipeline;
        const generation = recognitionGeneration.current;
        const cameraTracker = trackerRef.current;
        void pipeline!.process(image)
          .then((result) => {
            if (generation !== recognitionGeneration.current || pipelineRef.current !== pipeline
              || trackerRef.current !== cameraTracker || cameraSuspended.current || xrSession.current) return;
            // Colour-coded discrepancy: compare confirmed tracks against the
            // parts the active step expects, and publish it for the overlay.
            const st = useStore.getState();
            if (st.assembly !== frameState.assembly || st.activeStepId !== frameState.activeStepId) return;
            setPipelineStatus(pipeline!.status());
            if (!result) { st.setRecognition(undefined); return; }
            st.setRecognition(classifyRecognition(result.tracks, labelInfoFor(st), result.ts));
          })
          .catch((error) => {
            if (generation === recognitionGeneration.current && pipelineRef.current === pipeline) {
              const status = pipeline!.status();
              setPipelineStatus({
                ...status, errors: { ...status.errors, detector: `Inference failed: ${String(error)}` },
              });
              useStore.getState().setRecognition(undefined);
            }
          })
          .finally(() => { if (busyPipeline === pipeline) busyPipeline = undefined; });
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    } catch (error) {
      if (current()) {
        stop();
        useStore.getState().setArError(`AR could not start. Try again or use the 3D preview: ${String(error)}`);
      }
    } finally {
      if (generation === sessionGeneration.current) entryPending.current = false;
    }
  }, [arActive, capabilities, assembly, stop, startCamera, videoRef]);

  /**
   * Ask for a real AR session again, from this tap.
   *
   * The automatic attempt happens inside `enterAr`, after capability checks and
   * a camera permission prompt — by which time the activation from the original
   * tap may be gone, and a refused session is indistinguishable from a device
   * that cannot do AR. This is a button whose click leads straight to
   * `requestSession` with nothing awaited in front of it, which is the sequence
   * that worked before the app started entering sessions on its own.
   */
  const retryWebXr = useCallback(async () => {
    if (capabilities?.permissionsPolicy?.['xr-spatial-tracking'] === 'denied') {
      useStore.getState().setArError('World-tracked AR is blocked by embedding policy. Ask the host to allow xr-spatial-tracking in its iframe and Permissions-Policy header. Camera/3D preview remains available.');
      return false;
    }
    if (entryPending.current || retryPending.current || xrSession.current) return false;
    const manager = getActiveManager();
    if (!manager) return false;
    const generation = ++sessionGeneration.current;
    const startAssembly = useStore.getState().assembly;
    retryPending.current = true;
    const current = () => generation === sessionGeneration.current && useStore.getState().assembly === startAssembly;
    try {
      return await startXr(manager, current);
    } catch (error) {
      if (current()) useStore.getState().setArError(`WebXR could not start; camera/3D preview remains available: ${String(error)}`);
      return false;
    } finally {
      if (generation === sessionGeneration.current) retryPending.current = false;
    }
  }, [capabilities, startXr]);

  /**
   * Move the assembly into view, now, without a placement gesture.
   *
   * The escape hatch for an anchor the operator cannot find: it lands in front
   * of wherever they are looking, at a distance derived from its own size. Aim
   * and tap still re-places it properly afterwards.
   */
  const bringInFront = useCallback(() => {
    const manager = getActiveManager();
    if (!manager || !arActive) return;
    stopPlacement.current?.();
    stopPlacement.current = undefined;
    objectAnchor.current?.reset();
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    useStore.getState().setAnchor(manager.bringInFront(), 0.6, 'manual');
  }, [arActive]);

  /**
   * Put the assembly somewhere else: go back to aiming at the floor.
   *
   * Operators move. Without this the only way to correct a placement was to
   * leave AR and come back, which loses the build state on screen.
   */
  const replaceAnchor = useCallback(() => {
    const manager = getActiveManager();
    if (!manager || !arActive) return;
    stopPlacement.current?.();
    stopPlacement.current = undefined;
    // Forget the object lock too: "Move" means the operator wants to say where
    // this goes, and a tracked recognition would otherwise pull it straight back.
    objectAnchor.current?.reset();
    useStore.getState().setAnchor(undefined, 0, 'awaiting');

    useStore.getState().setArPlacement('awaiting');
    if (xrSession.current) {
      // In a WebXR session the surface comes from the device, so re-arming is
      // all there is to do: the reticle reappears on the real floor.
      manager.setPlacementActive(true);
      return;
    }
    stopPlacement.current = manager.startGroundPlacement(
      surfaceDrop(useStore.getState().arSettings),
      (pose) => {
        useStore.getState().setAnchor(pose, 0.6, 'floor');
        stopPlacement.current = undefined;
      },
      { floorIsGuesswork: () => !useStore.getState().arMotion },
    );
  }, [arActive]);

  /**
   * Hand the camera back while the tab is in the background, and take it again
   * on return.
   *
   * A hidden tab holding the camera is why the next one cannot have it: the
   * operator switches away, opens the app again, and gets `NotReadableError`
   * from a device their own first tab is still holding. The wake lock is
   * dropped by the browser in the same situation and re-taken the same way.
   */
  useEffect(() => {
    if (!arActive) return;
    const onVisibility = (): void => {
      const video = videoRef.current;
      if (document.visibilityState === 'hidden') {
        if (xrSession.current) return;   // an XR session manages its own lifecycle
        sessionGeneration.current++;
        retryPending.current = false;
        recognitionGeneration.current++;
        pipelineRef.current?.resetTemporal();
        useStore.getState().setRecognition(undefined);
        trackerRef.current?.stop();
        trackerRef.current = undefined;
        releaseVideo(video);
        cameraSuspended.current = true;
        return;
      }
      if (wakeLock.current === undefined || wakeLock.current.released) {
        const generation = sessionGeneration.current;
        void takeWakeLock().then((lock) => {
          if (generation !== sessionGeneration.current) {
            void lock?.release().catch(() => undefined);
          } else {
            wakeLock.current = lock;
          }
        });
      }
      if (cameraSuspended.current && video) {
        cameraSuspended.current = false;
        const generation = sessionGeneration.current;
        void startCamera(video, generation).then((started) => {
          if (!started && generation === sessionGeneration.current) stop();
        }).catch((error) => {
          if (generation !== sessionGeneration.current) return;
          stop();
          useStore.getState().setArError(`Camera could not resume. Try AR again: ${String(error)}`);
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [arActive, startCamera, stop, videoRef]);

  useEffect(() => () => stop(), [stop]);

  return { capabilities, pipelineStatus, arActive, enterAr, replaceAnchor, bringInFront, retryWebXr };
}

/**
 * Decide whether AR should open in placement mode, and arm it if so.
 *
 * Placement is a mode with a cost: the reticle sits over the work and a tap
 * moves the assembly. That is exactly right the first time and wrong every time
 * after, so it is asked for rather than assumed — by the setting, or by there
 * being nothing placed yet. "Move" in the HUD re-arms it on demand.
 *
 * Returns whether placement was armed.
 */
function armPlacement(manager: SceneManager, source: 'webxr' | 'camera'): boolean {
  const state = useStore.getState();
  const wanted = state.arSettings.placeOnEntry || !state.anchor;
  if (!wanted) {
    manager.setPlacementActive(false);
    // Keep whatever the anchor already says about itself; only a stale 'idle'
    // needs correcting, since something is on screen.
    if (state.arPlacement === 'idle' || state.arPlacement === 'awaiting') {
      state.setArPlacement('manual');
    }
    return false;
  }
  if (source === 'webxr') manager.setPlacementActive(true);
  state.setArPlacement('awaiting');
  return true;
}

/**
 * Push one object observation into the world.
 *
 * The observation is in the camera's frame, so it only means something once it
 * has been taken through the live camera into world space; from there the
 * target's declared pose on the assembly gives the anchor, and every part
 * follows because they all hang off it.
 *
 * A printed marker is the more precise reference, so a good marker lock is
 * never overruled by a recognition.
 */
function applyObjectAnchor(
  tracker: ObjectAnchorTracker,
  image: ImageData,
  nowMs: number,
  manager: SceneManager | undefined,
  target: GridTargetDef,
): boolean {
  if (!manager) return false;
  const obs = tracker.update(image, nowMs, manager.effectiveFovDeg());
  if (!obs) return false;

  const world = manager.cameraToWorld(obs.pose);
  const anchor = alignToMarker(world, target.poseInAssembly);
  const state = useStore.getState();
  if (state.arPlacement === 'marker' && state.anchorQuality >= obs.confidence) return false;
  state.setAnchor(anchor, obs.confidence, 'recognized');
  return true;
}

/** Map the assembly + active step into recognisable labels for the verdict. */
function labelInfoFor(state: ReturnType<typeof useStore.getState>): LabelInfo {
  const known = new Map<string, string>();
  for (const p of state.assembly.parts) known.set(p.id, p.name);
  const step = state.assembly.steps.find((s) => s.id === state.activeStepId);
  const expected = new Set<string>(step?.partIds ?? []);
  return { known, expected };
}
