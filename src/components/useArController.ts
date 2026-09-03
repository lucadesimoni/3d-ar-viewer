import { useCallback, useEffect, useRef, useState } from 'react';
import { detectCapabilities, type Capabilities } from '../engine/tracking/capabilities';
import { CameraTracker } from '../engine/tracking/cameraTracker';
import { MarkerTracker } from '../engine/tracking/markerTracking';
import { RecognitionPipeline, type PipelineStatus } from '../vision/pipeline';
import { toImageData } from '../vision/opencv';
import { alignToMarker } from '../engine/alignment';
import { useStore } from '../state/store';

/**
 * Orchestrates the whole AR runtime for the current device.
 *
 * It probes capabilities once, lazily boots the recognition pipeline, and on
 * "enter AR" starts the right tracker: WebXR is handled by the Babylon scene, so
 * here we drive the iOS-critical fallback — camera passthrough plus marker
 * re-registration and, when a video frame is available, the CV/ML pipeline.
 */
export function useArController(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>();
  const [arActive, setArActive] = useState(false);
  const trackerRef = useRef<CameraTracker | undefined>(undefined);
  const markerRef = useRef<MarkerTracker | undefined>(undefined);
  const pipelineRef = useRef<RecognitionPipeline | undefined>(undefined);
  const frameTimer = useRef<number | undefined>(undefined);

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
    const pipeline = new RecognitionPipeline({ normalizeLighting: true });
    pipelineRef.current = pipeline;
    pipeline.init().then((s) => alive && setPipelineStatus(s));
    return () => { alive = false; };
  }, [setArMode]);

  const stop = useCallback(() => {
    if (frameTimer.current) window.clearInterval(frameTimer.current);
    markerRef.current?.stop();
    trackerRef.current?.stop();
    trackerRef.current = undefined;
    setArActive(false);
  }, []);

  const enterAr = useCallback(async () => {
    if (arActive) { stop(); return; }
    const video = videoRef.current;
    if (!video || !capabilities) return;

    // iOS gates motion behind a user gesture — this call is inside the click.
    if (capabilities.motionNeedsPermission) await CameraTracker.requestMotionPermission();

    const tracker = new CameraTracker();
    trackerRef.current = tracker;
    await tracker.start(video);
    if (tracker.state.error) return;
    setArActive(true);

    // Marker re-registration: when the fiducial is in view, snap the anchor to it.
    if (assembly.marker) {
      const marker = new MarkerTracker(assembly.marker.sizeM, (obs) => {
        if (obs.id !== assembly.marker!.id) return;
        const anchor = alignToMarker(obs.pose, assembly.marker!.poseInAssembly);
        const quality = Math.max(0, Math.min(1, 1 - obs.reprojectionPx / 8));
        setAnchor(anchor, quality);
        tracker.markRegistered();
      });
      markerRef.current = marker;
      marker.start(video);
    }

    // Recognition loop: sample the passthrough, feed the CV/ML pipeline, and use
    // the result to catch wrong-part picks against the active step's expectation.
    const pipeline = pipelineRef.current;
    if (pipeline) {
      frameTimer.current = window.setInterval(async () => {
        if (video.readyState < 2) return;
        const image = toImageData(video, 480, Math.round((480 * video.videoHeight) / (video.videoWidth || 640)));
        if (image) await pipeline.process(image);
      }, 500);
    }
  }, [arActive, capabilities, assembly, setAnchor, stop, videoRef]);

  useEffect(() => () => stop(), [stop]);

  return { capabilities, pipelineStatus, arActive, enterAr };
}
