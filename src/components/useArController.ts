import { useCallback, useEffect, useRef, useState } from 'react';
import { detectCapabilities, type Capabilities } from '../engine/tracking/capabilities';
import { CameraTracker } from '../engine/tracking/cameraTracker';
import { MarkerTracker } from '../engine/tracking/markerTracking';
import { RecognitionPipeline, type PipelineStatus } from '../vision/pipeline';
import { envModelConfig } from '../vision/defaultModels';
import { classifyRecognition, type LabelInfo } from '../vision/verdict';
import { ObjectAnchorTracker } from '../vision/objectAnchor';
import { detectPerfProfile } from '../render/perf';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { toImageData } from '../vision/opencv';
import { alignToMarker } from '../engine/alignment';
import { useStore } from '../state/store';
import type { GridTargetDef } from '../engine/types';
import type { SceneManager } from '../render/babylon/SceneManager';

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

export function useArController(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>();
  const [arActive, setArActive] = useState(false);
  const trackerRef = useRef<CameraTracker | undefined>(undefined);
  const markerRef = useRef<MarkerTracker | undefined>(undefined);
  const pipelineRef = useRef<RecognitionPipeline | undefined>(undefined);
  const frameTimer = useRef<number | undefined>(undefined);
  const previewTimer = useRef<number | undefined>(undefined);
  const stopPlacement = useRef<(() => void) | undefined>(undefined);
  const xrSession = useRef<{ end: () => Promise<void> } | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);
  const wakeLock = useRef<WakeLock | undefined>(undefined);
  const objectAnchor = useRef<ObjectAnchorTracker | undefined>(undefined);
  const videoGeometryCleanup = useRef<(() => void) | undefined>(undefined);

  const setAnchor = useStore((s) => s.setAnchor);
  const assembly = useStore((s) => s.assembly);
  const setArMode = useStore((s) => s.setArMode);

  // Recognition is temporally smoothed; a step change means a different expected
  // part, so clear the tracker/voter history rather than carrying stale votes.
  const activeStepId = useStore((s) => s.activeStepId);
  useEffect(() => {
    pipelineRef.current?.resetTemporal();
  }, [activeStepId]);

  useEffect(() => {
    let alive = true;
    detectCapabilities().then((caps) => {
      if (!alive) return;
      setCapabilities(caps);
      setArMode(caps.recommended);
      // Requesting an XR session needs the user's click to still be "fresh".
      // Loading 300 kB of WebXR code first can spend that activation, so pull
      // the module in now, while nobody is waiting for it.
      if (caps.immersiveAr) void import('../render/babylon/xr');
    });
    // Boot the recognition pipeline in the background; no models are bundled, so
    // this only wires up OpenCV unless a deployment supplies model URLs.
    // Models come from VITE_* env vars (see .env.example); with none set the
    // pipeline runs geometry-only and recognition stays quiet.
    const pipeline = new RecognitionPipeline(envModelConfig());
    pipelineRef.current = pipeline;
    pipeline.init().then((s) => alive && setPipelineStatus(s));
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

    const store = useStore.getState();
    store.setRecognition(undefined);
    store.setArPlacement('idle');
    store.setArSource(undefined);
  }, [videoRef]);

  const enterAr = useCallback(async () => {
    if (arActive) { stop(); return; }
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
    const manager = getActiveManager();

    // 1. A device with real AR: let WebXR find the floor and place on a tap.
    if (capabilities.immersiveAr && manager) {
      const session = await manager.startWebXr(
        (pose) => useStore.getState().setAnchor(pose, 0.9, 'floor'),
        // Leaving the session (the system back gesture, or the headset's own
        // exit) has to take the app out of AR too, or the UI claims to be in a
        // session that ended.
        () => stop(),
      );
      if (session) {
        xrSession.current = session;
        useStore.getState().setArSource('webxr');
        wakeLock.current = await takeWakeLock();
        armPlacement(manager, 'webxr');
        setArActive(true);
        return;
      }
      // The session was refused or could not be entered — fall through to
      // camera passthrough rather than leaving a transparent canvas over a
      // black page, which is what "AR" looked like before this fell through.
    }

    const video = videoRef.current;
    if (!video) {
      store.setArError('The camera surface is missing — reload the page.');
      return;
    }
    if (!capabilities.camera) {
      store.setArError('This browser exposes no camera. AR falls back to the 3D preview.');
      return;
    }

    // iOS gates motion behind a user gesture — this call is inside the click.
    if (capabilities.motionNeedsPermission) await CameraTracker.requestMotionPermission();

    wakeLock.current = await takeWakeLock();

    const tracker = new CameraTracker();
    trackerRef.current = tracker;
    await tracker.start(video);
    if (tracker.state.error) {
      // Say what happened. Doing nothing at all was indistinguishable from a
      // broken build, and the commonest cause is a permission the operator can
      // grant in two taps once they know that is what is being asked.
      store.setArError(tracker.state.error);
      trackerRef.current = undefined;
      return;
    }
    useStore.getState().setArError(undefined);
    useStore.getState().setArSource('camera');
    setArActive(true);

    // Put the 3D scene into AR: transparent clear, head camera, orbit controls
    // off — then drive that camera from the device's orientation.
    manager?.setArMode(true);
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
    videoGeometryCleanup.current = () => video.removeEventListener('loadedmetadata', publishGeometry);
    tracker.subscribe((st) => {
      getActiveManager()?.setDeviceOrientation(st.orientation);
    });

    // 4. Aim at the floor and tap. The reticle follows the ground plane implied
    // by gravity and eye height, so the tap lands at a real distance.
    if (manager && armPlacement(manager, 'camera')) {
      stopPlacement.current = manager.startGroundPlacement(
        useStore.getState().arSettings.eyeHeightM,
        (pose) => {
          useStore.getState().setAnchor(pose, 0.6, 'floor');
          stopPlacement.current = undefined;
        },
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

    // 3. Marker re-registration: when the fiducial is in view, snap the anchor
    // to it. The observation is in the camera's frame, so it has to be taken
    // into world space through the live camera before it means anything.
    if (assembly.marker) {
      const marker = new MarkerTracker(assembly.marker.sizeM, (obs) => {
        if (obs.id !== assembly.marker!.id) return;
        const world = getActiveManager()?.cameraToWorld(obs.pose) ?? obs.pose;
        const anchor = alignToMarker(world, assembly.marker!.poseInAssembly);
        const quality = Math.max(0, Math.min(1, 1 - obs.reprojectionPx / 8));
        setAnchor(anchor, quality, 'marker');
        stopPlacement.current?.();
        stopPlacement.current = undefined;
        tracker.markRegistered();
      });
      markerRef.current = marker;
      marker.start(video);
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
    let pipelineBusy = false;

    const loop = (now: number): void => {
      rafRef.current = requestAnimationFrame(loop);
      if (video.readyState < 2) return;
      const anchorDue = objectAnchor.current !== undefined && now - lastTrack >= trackIntervalMs;
      const pipeline = pipelineRef.current;
      const pipelineDue = pipeline !== undefined && !pipelineBusy
        && now - lastPipeline >= perf.recognitionIntervalMs;
      if (!anchorDue && !pipelineDue) return;

      const height = Math.round((FRAME_WIDTH * video.videoHeight) / (video.videoWidth || 640));
      const image = toImageData(video, FRAME_WIDTH, height);
      if (!image) return;

      if (anchorDue) {
        lastTrack = now;
        if (useStore.getState().arSettings.autoRecognize) {
          const anchored = applyObjectAnchor(objectAnchor.current!, image, now, manager, assembly.recognition!);
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
        pipelineBusy = true;
        void pipeline!.process(image)
          .then((result) => {
            if (!result) return;
            // Colour-coded discrepancy: compare confirmed tracks against the
            // parts the active step expects, and publish it for the overlay.
            const st = useStore.getState();
            st.setRecognition(classifyRecognition(result.tracks, labelInfoFor(st), result.ts));
          })
          .finally(() => { pipelineBusy = false; });
      }
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [arActive, capabilities, assembly, setAnchor, stop, videoRef]);

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
      useStore.getState().arSettings.eyeHeightM,
      (pose) => {
        useStore.getState().setAnchor(pose, 0.6, 'floor');
        stopPlacement.current = undefined;
      },
    );
  }, [arActive]);

  // The browser drops the wake lock when the page is hidden; take it again when
  // the operator comes back to a still-running AR session.
  useEffect(() => {
    if (!arActive) return;
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (wakeLock.current && !wakeLock.current.released) return;
      void takeWakeLock().then((lock) => { wakeLock.current = lock; });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [arActive]);

  useEffect(() => () => stop(), [stop]);

  return { capabilities, pipelineStatus, arActive, enterAr, replaceAnchor };
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
