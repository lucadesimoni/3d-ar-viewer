import { useCallback, useEffect, useRef, useState } from 'react';
import { detectCapabilities, type Capabilities } from '../engine/tracking/capabilities';
import { CameraTracker } from '../engine/tracking/cameraTracker';
import {
  MarkerTracker,
  estimateIntrinsics,
  rectPoseFromCorners,
} from '../engine/tracking/markerTracking';
import { RecognitionPipeline, type PipelineStatus } from '../vision/pipeline';
import { envModelConfig } from '../vision/defaultModels';
import { classifyRecognition, type LabelInfo } from '../vision/verdict';
import { detectGridFacade, matchesGridTarget } from '../vision/gridRecognition';
import { detectPerfProfile } from '../render/perf';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { toImageData } from '../vision/opencv';
import { alignToMarker } from '../engine/alignment';
import { useStore } from '../state/store';
import type { GridTargetDef, Pose } from '../engine/types';

/**
 * Orchestrates the whole AR runtime for the current device.
 *
 * The anchoring strategy, in the order the app tries it:
 *
 *  1. **WebXR hit-test** — a real plane reported by the device. The reticle sits
 *     on the actual floor and the anchor is world-locked, so the operator can
 *     walk around the assembly. Android, Quest, Vision Pro.
 *  2. **Object recognition** — the assembly's own facade, found in the camera
 *     frame by `vision/gridRecognition`, which yields a full metric pose with no
 *     marker and no setup. This is what "recognise the object and keep the rest
 *     aligned to it" means in practice: every part hangs off `assemblyRoot`, so
 *     one recognised pose carries the whole build with it.
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
/** Two detections must agree within this to be trusted, metres. */
const GRID_AGREEMENT_M = 0.2;

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
  const lastGrid = useRef<Pose | undefined>(undefined);
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
    if (frameTimer.current) window.clearInterval(frameTimer.current);
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    stopPlacement.current?.();
    stopPlacement.current = undefined;
    videoGeometryCleanup.current?.();
    videoGeometryCleanup.current = undefined;
    void xrSession.current?.end();
    xrSession.current = undefined;
    markerRef.current?.stop();
    trackerRef.current?.stop();
    getActiveManager()?.setArMode(false);
    trackerRef.current = undefined;
    lastGrid.current = undefined;
    useStore.getState().setRecognition(undefined);
    useStore.getState().setArPlacement('idle');
    setArActive(false);
  }, []);

  const enterAr = useCallback(async () => {
    if (arActive) { stop(); return; }
    if (!capabilities) return;
    const manager = getActiveManager();

    // 1. A device with real AR: let WebXR find the floor and place on a tap.
    if (capabilities.immersiveAr && manager) {
      const session = await manager.startWebXr((pose) => {
        useStore.getState().setAnchor(pose, 0.9, 'floor');
      });
      if (session) {
        xrSession.current = session;
        useStore.getState().setArPlacement('awaiting');
        setArActive(true);
        return;
      }
      // Falls through to passthrough when the session is refused.
    }

    const video = videoRef.current;
    if (!video) return;

    // iOS gates motion behind a user gesture — this call is inside the click.
    if (capabilities.motionNeedsPermission) await CameraTracker.requestMotionPermission();

    const tracker = new CameraTracker();
    trackerRef.current = tracker;
    await tracker.start(video);
    if (tracker.state.error) return;
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
    if (manager) {
      useStore.getState().setArPlacement('awaiting');
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

    // Frame loop: object recognition first (it anchors the overlay), then the
    // CV/ML pipeline for wrong-part detection.
    frameTimer.current = window.setInterval(async () => {
      if (video.readyState < 2) return;
      const image = toImageData(video, 480, Math.round((480 * video.videoHeight) / (video.videoWidth || 640)));
      if (!image) return;

      // 2. Recognise the assembly itself and align everything to it.
      if (assembly.recognition && useStore.getState().arSettings.autoRecognize) {
        const anchored = tryGridAnchor(image, assembly.recognition, lastGrid);
        if (anchored) {
          stopPlacement.current?.();
          stopPlacement.current = undefined;
          if (previewTimer.current) window.clearTimeout(previewTimer.current);
        }
      }

      const pipeline = pipelineRef.current;
      if (!pipeline) return;
      const result = await pipeline.process(image);
      if (!result) return;
      // Colour-coded discrepancy: compare confirmed tracks against the parts
      // the active step expects, and publish the verdict for the overlay.
      const st = useStore.getState();
      const info = labelInfoFor(st);
      useStore.getState().setRecognition(classifyRecognition(result.tracks, info, result.ts));
    }, detectPerfProfile().recognitionIntervalMs);
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
    lastGrid.current = undefined;
    useStore.getState().setAnchor(undefined, 0, 'awaiting');
    stopPlacement.current = manager.startGroundPlacement(
      useStore.getState().arSettings.eyeHeightM,
      (pose) => {
        useStore.getState().setAnchor(pose, 0.6, 'floor');
        stopPlacement.current = undefined;
      },
    );
  }, [arActive]);

  useEffect(() => () => stop(), [stop]);

  return { capabilities, pipelineStatus, arActive, enterAr, replaceAnchor };
}

/**
 * Try to anchor the assembly to its own recognised facade.
 *
 * A single frame is not enough: one confident-looking lattice in a bookshelf or
 * a window frame would yank the overlay across the room. Two consecutive
 * detections have to agree to within 200 mm before the anchor moves, which is
 * cheap and rejects essentially every one-frame false positive.
 *
 * Returns true when the anchor was updated.
 */
function tryGridAnchor(
  image: ImageData,
  target: GridTargetDef,
  lastGrid: { current: Pose | undefined },
): boolean {
  const obs = detectGridFacade(image);
  if (!obs || !matchesGridTarget(obs, target)) {
    lastGrid.current = undefined;
    return false;
  }
  const manager = getActiveManager();
  if (!manager) return false;
  // Same field of view the overlay is rendered with, so a recognised pose and
  // the rendering cannot disagree.
  const K = estimateIntrinsics(image.width, image.height, manager.effectiveFovDeg());
  const solved = rectPoseFromCorners(obs.quad, target.widthM, target.heightM, K);
  if (!solved || solved.reprojectionPx > 6) return false;
  const world = manager.cameraToWorld(solved.pose);
  const anchor = alignToMarker(world, target.poseInAssembly);

  const previous = lastGrid.current;
  lastGrid.current = anchor;
  if (!previous) return false;
  const drift = Math.hypot(
    anchor.position[0] - previous.position[0],
    anchor.position[1] - previous.position[1],
    anchor.position[2] - previous.position[2],
  );
  if (drift > GRID_AGREEMENT_M) return false;

  const state = useStore.getState();
  const quality = Math.max(0, Math.min(1, obs.confidence * (1 - solved.reprojectionPx / 8)));
  // A printed marker is the more precise reference; never overrule a good one.
  if (state.arPlacement === 'marker' && state.anchorQuality >= quality) return false;
  state.setAnchor(anchor, quality, 'recognized');
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
