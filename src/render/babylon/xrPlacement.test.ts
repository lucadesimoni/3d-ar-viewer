import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Observable } from '@babylonjs/core/Misc/observable';
import { WebXRState } from '@babylonjs/core/XR/webXRTypes';
import { bindXrPlacement, prepareImmersiveAr } from './xr';

const createExperience = vi.hoisted(() => vi.fn());
vi.mock('@babylonjs/core/XR/webXRDefaultExperience', () => ({
  WebXRDefaultExperience: { CreateAsync: createExperience },
}));

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const overlay = document.createElement('div');
  const session = new EventTarget();
  const hitTest = {
    autoCloneTransformation: false,
    onHitTestResultObservable: new Observable<Array<{
      position: { x: number; y: number; z: number };
      rotationQuaternion: { x: number; y: number; z: number; w: number };
    }>>(),
  };
  const sessionManager = {
    session,
    onXRSessionInit: new Observable<EventTarget>(),
  };
  const baseExperience = {
    state: WebXRState.NOT_IN_XR,
    onStateChangedObservable: new Observable<WebXRState>(),
    sessionManager,
    featuresManager: { enableFeature: vi.fn(() => hitTest) },
    enterXRAsync: vi.fn(async (
      _mode: XRSessionMode, _space: XRReferenceSpaceType, _target: unknown, _options: XRSessionInit,
    ) => {
      sessionManager.onXRSessionInit.notifyObservers(session);
      emit(WebXRState.IN_XR);
    }),
    exitXRAsync: vi.fn(async () => {
      emit(WebXRState.EXITING_XR);
      emit(WebXRState.NOT_IN_XR);
    }),
  };
  const emit = (state: WebXRState) => {
    baseExperience.state = state;
    baseExperience.onStateChangedObservable.notifyObservers(state);
  };
  createExperience.mockResolvedValue({ baseExperience, renderTarget: {}, dispose: vi.fn() });
  const hit = () => hitTest.onHitTestResultObservable.notifyObservers([{
    position: { x: 1, y: 0, z: 2 },
    rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
  }]);
  return { engine, scene, overlay, session, baseExperience, hitTest, emit, hit };
}

describe('WebXR surface placement', () => {
  it('uses XR select even when camera placement replaces or clears the scene handler', async () => {
    const f = fixture();
    const onSelectAnchor = vi.fn();
    const cameraHandler = vi.fn();
    f.scene.onPointerDown = cameraHandler;
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onSelectAnchor });
    expect(f.scene.onPointerDown).toBe(cameraHandler);
    await prepared!.enter();
    f.scene.onPointerDown = undefined;
    f.hit();
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).toHaveBeenCalledExactlyOnceWith({
      position: [1, 0, 2], rotation: [0, 0, 0, 1],
    });
    expect(cameraHandler).not.toHaveBeenCalled();
    expect(f.hitTest.autoCloneTransformation).toBe(true);
    prepared!.dispose();
    f.engine.dispose();
  });

  it('does not place at a stale surface after hit testing loses it', async () => {
    const f = fixture();
    const onSelectAnchor = vi.fn();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onSelectAnchor });
    await prepared!.enter();
    f.hit();
    f.hitTest.onHitTestResultObservable.notifyObservers([]);
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).not.toHaveBeenCalled();
    prepared!.dispose();
    f.engine.dispose();
  });

  it('reports the session end once, only after Babylon restores the scene', async () => {
    const f = fixture();
    const onStateChange = vi.fn();
    const onSelectAnchor = vi.fn();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onStateChange, onSelectAnchor });
    await prepared!.enter();
    f.hit();
    f.emit(WebXRState.EXITING_XR);
    expect(onStateChange.mock.calls).toEqual([[true]]);
    f.emit(WebXRState.NOT_IN_XR);
    f.emit(WebXRState.NOT_IN_XR);
    expect(onStateChange.mock.calls).toEqual([[true], [false]]);
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).not.toHaveBeenCalled();
    prepared!.dispose();
    f.engine.dispose();
  });

  it('preserves camera input after a refused entry and never retries in viewer space', async () => {
    const f = fixture();
    const cameraHandler = vi.fn();
    const onStateChange = vi.fn();
    f.scene.onPointerDown = cameraHandler;
    f.baseExperience.enterXRAsync.mockRejectedValue(new DOMException('Unsupported space', 'NotSupportedError'));
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onStateChange });
    for (let i = 0; i < 4; i++) await expect(prepared!.enter()).resolves.toBeUndefined();
    expect(f.scene.onPointerDown).toBe(cameraHandler);
    expect(onStateChange).not.toHaveBeenCalled();
    expect(f.baseExperience.enterXRAsync.mock.calls.map((args) => args[1]))
      .toEqual(['local-floor', 'local', 'local', 'local']);
    for (const args of f.baseExperience.enterXRAsync.mock.calls) {
      expect(args[3]).toEqual({ requiredFeatures: [args[1]] });
    }
    prepared!.dispose();
    f.engine.dispose();
  });

  it('disposes input listeners without changing the camera fallback handler', async () => {
    const f = fixture();
    const onSelectAnchor = vi.fn();
    const cameraHandler = vi.fn();
    f.scene.onPointerDown = cameraHandler;
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onSelectAnchor });
    await prepared!.enter();
    f.hit();
    prepared!.dispose();
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).not.toHaveBeenCalled();
    expect(f.scene.onPointerDown).toBe(cameraHandler);
    f.engine.dispose();
  });
});

describe('XR DOM overlay input', () => {
  it('lets canvas taps select but suppresses XR selection from HUD controls', () => {
    const root = document.createElement('div');
    const canvas = document.createElement('canvas');
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.append(label);
    root.append(canvas, button);
    const session = new EventTarget();
    const onSelect = vi.fn();
    const unbind = bindXrPlacement(session, root, canvas, onSelect);
    const selectFrom = (target: HTMLElement) => {
      const event = new Event('beforexrselect', { bubbles: true, cancelable: true });
      if (target.dispatchEvent(event)) session.dispatchEvent(new Event('select'));
      return event.defaultPrevented;
    };
    expect(selectFrom(canvas)).toBe(false);
    expect(selectFrom(label)).toBe(true);
    expect(selectFrom(root)).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    unbind();
    expect(selectFrom(label)).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
