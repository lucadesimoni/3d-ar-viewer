import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useArController } from './useArController';
import { useStore } from '../state/store';
import type { MarkerObservation } from '../engine/tracking/markerTracking';
import type { PipelineConfig } from '../vision/pipeline';
import type { Capabilities } from '../engine/tracking/capabilities';

const f = vi.hoisted(() => {
  const stopPlacement = vi.fn();
  return {
    stopPlacement,
    tracker: { state: { running: true, error: undefined as string | undefined }, start: vi.fn(), stop: vi.fn(), subscribe: vi.fn(), markRegistered: vi.fn() },
    capabilities: {
      secureContext: true, webxrSupported: true, immersiveAr: true, camera: true, recommended: 'webxr',
      permissionsPolicy: undefined as Capabilities['permissionsPolicy'],
    },
    marker: { start: vi.fn(), stop: vi.fn() },
    markerCallback: undefined as ((observation: MarkerObservation) => void) | undefined,
    markerCalibration: undefined as ((width: number, height: number) => unknown) | undefined,
    session: { end: vi.fn() },
    pipeline: { init: vi.fn(), resetTemporal: vi.fn(), dispose: vi.fn(), process: vi.fn(), create: vi.fn(), status: vi.fn() },
    manager: {
      prepareWebXr: vi.fn(),
      startWebXr: vi.fn(),
      onXrTracking: vi.fn(),
      frameIntrinsics: vi.fn(({ width, height }: { width: number; height: number }) => ({
        fx: 1317, fy: 1317, cx: width / 2, cy: height / 2, width, height,
        fovDeg: 72.18, source: 'xr-raw' as const,
      })),
      setArMode: vi.fn(),
      setPlacementActive: vi.fn(),
      cameraToWorld: vi.fn((pose) => pose),
      startGroundPlacement: vi.fn(() => stopPlacement),
      computeAnchorInFront: vi.fn(() => ({ position: [0, 0, 1], rotation: [0, 0, 0, 1] })),
    },
  };
});

vi.mock('../render/babylon/managerRegistry', () => ({ getActiveManager: () => f.manager }));
vi.mock('../engine/tracking/capabilities', () => ({
  detectCapabilities: async () => f.capabilities,
}));
vi.mock('../engine/tracking/cameraTracker', () => ({
  CameraTracker: class {
    state = f.tracker.state;
    start = f.tracker.start;
    stop = f.tracker.stop;
    subscribe = f.tracker.subscribe;
    markRegistered = f.tracker.markRegistered;
  },
}));
vi.mock('../engine/tracking/markerTracking', () => ({
  MarkerTracker: class {
    constructor(
      _size: number,
      onObservation: (observation: MarkerObservation) => void,
      calibration?: (width: number, height: number) => unknown,
    ) {
      f.markerCallback = onObservation;
      f.markerCalibration = calibration;
    }
    start = f.marker.start;
    stop = f.marker.stop;
  },
  estimateIntrinsics: (width: number, height: number) => ({
    fx: height, fy: height, cx: width / 2, cy: height / 2,
  }),
}));
vi.mock('../vision/pipeline', () => ({
  RecognitionPipeline: class {
    constructor(config: PipelineConfig) { f.pipeline.create(config); }
    init = f.pipeline.init;
    resetTemporal = f.pipeline.resetTemporal;
    dispose = f.pipeline.dispose;
    process = f.pipeline.process;
    status = f.pipeline.status;
  },
}));
vi.mock('../vision/opencv', async (original) => ({
  ...await original<typeof import('../vision/opencv')>(),
  toImageData: () => ({}),
}));
vi.mock('../render/perf', () => ({
  detectPerfProfile: () => ({ targetFps: 30, recognitionIntervalMs: 1000 }),
}));

let root: Root;
let controller: ReturnType<typeof useArController>;
let video: HTMLVideoElement;
let recognitionConfig: PipelineConfig | undefined;
let Harness: () => null;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  f.tracker.state.running = true;
  f.tracker.state.error = undefined;
  f.tracker.start.mockResolvedValue(undefined);
  f.session.end.mockResolvedValue(undefined);
  f.capabilities.permissionsPolicy = undefined;
  recognitionConfig = undefined;
  f.pipeline.init.mockResolvedValue({ detector: true });
  f.pipeline.status.mockReturnValue({ detector: true, classifier: false });
  f.pipeline.process.mockResolvedValue({ tracks: [], ts: 1 });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  f.manager.startWebXr.mockResolvedValue(undefined);
  useStore.setState(useStore.getInitialState(), true);
  video = document.createElement('video');
  const videoRef = { current: video };
  Harness = () => {
    controller = useArController(videoRef, recognitionConfig);
    return null;
  };
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Harness)));
  await act(async () => controller.enterAr());
  expect(useStore.getState().arSource).toBe('camera');
});

describe('recognition lifecycle', () => {
  it('surfaces runtime diagnostics even when a failed frame produces no result', async () => {
    Object.defineProperty(video, 'readyState', { value: 2 });
    f.pipeline.process.mockResolvedValue(undefined);
    f.pipeline.status.mockReturnValue({
      detector: true, classifier: false, errors: { detector: 'Unsupported model output' },
    });
    await act(async () => {
      useStore.getState().setArSettings({ autoRecognize: false });
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(controller.pipelineStatus?.errors?.detector).toBe('Unsupported model output');
    expect(useStore.getState().recognition).toBeUndefined();
  });

  it('does not publish a replaced configuration’s late load status', async () => {
    let finish!: (status: { detector: boolean; provider: string }) => void;
    f.pipeline.init.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    recognitionConfig = { temporal: true };
    await act(async () => root.render(createElement(Harness)));
    f.pipeline.init.mockResolvedValueOnce({ detector: true, provider: 'wasm' });
    recognitionConfig = { temporal: false };
    await act(async () => root.render(createElement(Harness)));
    await act(async () => finish({ detector: false, provider: 'old-provider' }));
    expect(controller.pipelineStatus).toMatchObject({ detector: true, provider: 'wasm' });
  });

  describe('device startup guards', () => {
    it('does not activate AR after a cancelled camera start with no error', async () => {
      await act(async () => controller.enterAr());
      f.tracker.state.running = false;
      await act(async () => controller.enterAr());
      expect(controller.arActive).toBe(false);
      expect(useStore.getState().arSource).toBeUndefined();
    });

    it.each(['stop', 'assembly', 'config'] as const)('discards camera startup after a %s change', async (change) => {
      await act(async () => controller.enterAr());
      let finish!: () => void;
      f.tracker.start.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
      let starting!: Promise<void>;
      await act(async () => { starting = controller.enterAr(); });
      expect(finish).toBeDefined();
      await act(async () => {
        if (change === 'stop') await controller.enterAr();
        if (change === 'assembly') useStore.setState({ assembly: { ...useStore.getState().assembly } });
        if (change === 'config') {
          recognitionConfig = {};
          root.render(createElement(Harness));
        }
      });
      await act(async () => { finish(); await starting; });
      expect(controller.arActive).toBe(false);
      expect(useStore.getState().arSource).toBeUndefined();
    });

    it('ends a late XR retry instead of reactivating an exited session', async () => {
      let finish!: (session: typeof f.session) => void;
      f.manager.startWebXr.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      let retry!: Promise<boolean>;
      await act(async () => { retry = controller.retryWebXr(); });
      await act(async () => controller.enterAr());
      await act(async () => {
        finish(f.session);
        expect(await retry).toBe(false);
      });

      expect(f.session.end).toHaveBeenCalledTimes(1);
      expect(controller.arActive).toBe(false);
      expect(useStore.getState().arSource).toBeUndefined();
    });

    it('ends a late initial XR session after its configuration was replaced', async () => {
      await act(async () => controller.enterAr());
      let finish!: (session: typeof f.session) => void;
      f.manager.startWebXr.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      let starting!: Promise<void>;
      await act(async () => { starting = controller.enterAr(); });
      recognitionConfig = {};
      await act(async () => root.render(createElement(Harness)));
      await act(async () => { finish(f.session); await starting; });
      expect(f.session.end).toHaveBeenCalledTimes(1);
      expect(controller.arActive).toBe(false);
      expect(useStore.getState().arSource).toBeUndefined();
    });

    it('avoids policy-denied XR requests and keeps the camera session usable', async () => {
      f.capabilities.permissionsPolicy = {
        camera: 'allowed', 'xr-spatial-tracking': 'denied',
        accelerometer: 'unknown', gyroscope: 'unknown', magnetometer: 'unknown',
      };
      const requests = f.manager.startWebXr.mock.calls.length;
      await act(async () => { expect(await controller.retryWebXr()).toBe(false); });
      expect(f.manager.startWebXr).toHaveBeenCalledTimes(requests);
      expect(controller.arActive).toBe(true);
      expect(useStore.getState().arError).toContain('xr-spatial-tracking');
      await act(async () => controller.enterAr());
      await act(async () => controller.enterAr());
      expect(f.manager.startWebXr).toHaveBeenCalledTimes(requests);
      expect(useStore.getState().arSource).toBe('camera');
    });

    it('does not prepare XR or request a camera when both are policy-denied', async () => {
      await act(async () => root.unmount());
      f.capabilities.permissionsPolicy = {
        camera: 'denied', 'xr-spatial-tracking': 'denied',
        accelerometer: 'unknown', gyroscope: 'unknown', magnetometer: 'unknown',
      };
      f.manager.prepareWebXr.mockClear();
      f.manager.startWebXr.mockClear();
      f.tracker.start.mockClear();
      root = createRoot(document.createElement('div'));
      await act(async () => root.render(createElement(Harness)));
      await act(async () => controller.enterAr());
      expect(f.manager.prepareWebXr).not.toHaveBeenCalled();
      expect(f.manager.startWebXr).not.toHaveBeenCalled();
      expect(f.tracker.start).not.toHaveBeenCalled();
      expect(controller.arActive).toBe(false);
      expect(useStore.getState().arError).toContain('Permissions-Policy');
    });
  });

  it('runs the replacement model without waiting for a disposed model’s pending frame', async () => {
    let finish!: (result: { tracks: []; ts: number }) => void;
    f.pipeline.process.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    Object.defineProperty(video, 'readyState', { value: 2 });
    await act(async () => {
      useStore.getState().setArSettings({ autoRecognize: false });
      await vi.advanceTimersByTimeAsync(1100);
    });
    recognitionConfig = {};
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(f.pipeline.process).toHaveBeenCalledTimes(2);
    const current = useStore.getState().recognition;
    expect(current).toBeDefined();
    await act(async () => finish({ tracks: [], ts: 0 }));
    expect(useStore.getState().recognition).toBe(current);
  });

  it('replaces configured pipelines and disposes the previous models without restarting the camera', async () => {
    const stops = f.tracker.stop.mock.calls.length;
    recognitionConfig = { detector: { url: '/trained.onnx', inputSize: 320, labels: ['sku'] }, labelMapping: { sku: 'occ-1' } };
    await act(async () => root.render(createElement(Harness)));
    expect(f.pipeline.create).toHaveBeenLastCalledWith(recognitionConfig);
    expect(f.pipeline.dispose).toHaveBeenCalledTimes(1);
    expect(f.tracker.stop).toHaveBeenCalledTimes(stops);
  });

  it('resets history when replacing the assembly even with reused step IDs', async () => {
    const resets = f.pipeline.resetTemporal.mock.calls.length;
    await act(async () => {
      useStore.setState({ assembly: { ...useStore.getState().assembly } });
    });
    expect(f.pipeline.resetTemporal.mock.calls.length).toBeGreaterThan(resets);
    expect(useStore.getState().recognition).toBeUndefined();
  });

  it('replaces the marker tracker when the host loads another assembly during camera AR', async () => {
    const previousCallback = f.markerCallback!;
    const previousMarker = useStore.getState().assembly.marker!;
    const next = {
      ...useStore.getState().assembly,
      marker: { ...previousMarker, id: 'new-cad-datum', sizeM: 0.2 },
    };
    const starts = f.marker.start.mock.calls.length;
    await act(async () => useStore.getState().loadAssembly(next));
    expect(f.marker.start).toHaveBeenCalledTimes(starts + 1);
    expect(f.markerCallback).not.toBe(previousCallback);
    const observation = {
      id: previousMarker.id, pose: previousMarker.poseInAssembly,
      reprojectionPx: 0, apparentPx: 100, observedAtMs: 0,
    };
    await act(async () => previousCallback(observation));
    expect(useStore.getState().anchor).toBeUndefined();
    await act(async () => f.markerCallback?.({ ...observation, id: next.marker.id }));
    expect(useStore.getState().arPlacement).toBe('marker');
    expect(f.tracker.markRegistered).toHaveBeenCalledTimes(1);
    expect(controller.arActive).toBe(true);
  });

  it.each(['assembly', 'step', 'config', 'xr'] as const)('rejects an old frame after a %s swap', async (swap) => {
    let finish!: (result: { tracks: []; ts: number }) => void;
    f.pipeline.process.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    Object.defineProperty(video, 'readyState', { value: 2 });
    await act(async () => {
      useStore.getState().setArSettings({ autoRecognize: false });
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(f.pipeline.process).toHaveBeenCalled();
    await act(async () => {
      if (swap === 'assembly') useStore.setState({ assembly: { ...useStore.getState().assembly } });
      if (swap === 'step') useStore.setState({ activeStepId: 'another-step' });
      if (swap === 'config') {
        recognitionConfig = {};
        root.render(createElement(Harness));
      }
      if (swap === 'xr') {
        f.manager.startWebXr.mockResolvedValue(f.session);
        await controller.retryWebXr();
      }
    });
    await act(async () => finish({ tracks: [], ts: 1 }));
    expect(useStore.getState().recognition).toBeUndefined();
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('camera to WebXR handoff', () => {
  it('stops camera placement and tracking, then arms placement in the new XR space', async () => {
    const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame');
    f.manager.startWebXr.mockResolvedValue(f.session);
    await act(async () => { expect(await controller.retryWebXr()).toBe(true); });
    expect(f.stopPlacement).toHaveBeenCalledTimes(1);
    expect(f.tracker.stop).toHaveBeenCalledTimes(1);
    expect(f.marker.stop).toHaveBeenCalledTimes(1);
    expect(cancelFrame).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(f.manager.setPlacementActive).toHaveBeenLastCalledWith(true);
    expect(useStore.getState()).toMatchObject({
      arSource: 'webxr', arPlacement: 'awaiting', anchor: undefined,
    });

    // Neither an old preview timer nor a marker scan already in flight may
    // place camera-space coordinates into the new world-tracked session.
    await act(async () => {
      const marker = useStore.getState().assembly.marker!;
      f.markerCallback?.({
        id: marker.id, pose: marker.poseInAssembly,
        reprojectionPx: 0, apparentPx: 100, observedAtMs: 0,
      });
      await vi.advanceTimersByTimeAsync(6500);
    });
    expect(useStore.getState().anchor).toBeUndefined();
    expect(f.manager.computeAnchorInFront).not.toHaveBeenCalled();
  });

  it('discards an existing camera-space anchor even if placement on entry is disabled', async () => {
    await act(async () => {
      useStore.getState().setArSettings({ placeOnEntry: false });
      useStore.getState().setAnchor({ position: [3, 0, 4], rotation: [0, 0, 0, 1] }, 0.6, 'floor');
    });
    f.manager.startWebXr.mockResolvedValue(f.session);
    await act(async () => { await controller.retryWebXr(); });
    expect(useStore.getState().anchor).toBeUndefined();
    expect(f.manager.setPlacementActive).toHaveBeenLastCalledWith(true);
  });

  it('leaves the working camera placement intact when XR entry is refused', async () => {
    await act(async () => { expect(await controller.retryWebXr()).toBe(false); });
    expect(f.stopPlacement).not.toHaveBeenCalled();
    expect(f.tracker.stop).not.toHaveBeenCalled();
    expect(f.marker.stop).not.toHaveBeenCalled();
    expect(useStore.getState().arSource).toBe('camera');
    expect(controller.arActive).toBe(true);
  });
});

describe('what the marker tracker is told about the camera', () => {
  it('hands it the live calibration instead of leaving it on 60 degrees', async () => {
    // This argument was never passed. Every marker pose the app has produced
    // used the assumption — on a device that had measured 72.2 degrees, and
    // after the operator had moved the slider.
    expect(f.markerCalibration).toBeDefined();
    const k = f.markerCalibration?.(1080, 1920) as { fovDeg: number; source: string };
    expect(k.source).toBe('xr-raw');
    expect(k.fovDeg).toBeCloseTo(72.18, 2);
    // The whole frame, not the cropped view on screen.
    expect(f.manager.frameIntrinsics).toHaveBeenCalledWith({ width: 1080, height: 1920 });
  });
});
