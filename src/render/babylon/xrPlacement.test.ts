import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Observable } from '@babylonjs/core/Misc/observable';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { WebXRState } from '@babylonjs/core/XR/webXRTypes';
import { XR_OVERLAY_CLASS, bindXrPlacement, prepareImmersiveAr } from './xr';

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
  const anchor = { id: 7, transformationMatrix: Matrix.Translation(1, 0, 2) };
  const anchors = {
    onAnchorUpdatedObservable: new Observable<typeof anchor>(),
    addAnchorPointUsingHitTestResultAsync: vi.fn(async () => anchor),
  };
  const sessionManager = {
    session,
    onXRSessionInit: new Observable<EventTarget>(),
  };
  const baseExperience = {
    state: WebXRState.NOT_IN_XR,
    onStateChangedObservable: new Observable<WebXRState>(),
    sessionManager,
    featuresManager: {
      enableFeature: vi.fn((name: string) => (/anchor/i.test(name) ? anchors : hitTest)),
    },
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
  return { engine, scene, overlay, session, baseExperience, hitTest, anchors, anchor, emit, hit };
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
  it('places from a tap on the view and swallows only taps on controls', () => {
    // The rule used to be "only taps on the render canvas place", which was
    // right while the canvas was the top surface of the overlay. Then the
    // canvas was hidden so it could not paint over the camera — and a hidden
    // element is never an event target, so every tap read as a tap on the
    // chrome and every one was cancelled. Placing in a session stopped working
    // entirely while the camera path, which never goes through `select`, was
    // unaffected. The question is whether the tap hit a *control*.
    const root = document.createElement('div');
    const view = document.createElement('div');          // the window on the world
    const hud = document.createElement('div');
    const button = document.createElement('button');
    const label = document.createElement('span');        // a child of a control
    button.append(label);
    hud.append(button);
    root.append(view, hud);
    const session = new EventTarget();
    const onSelect = vi.fn();
    const unbind = bindXrPlacement(session, root, onSelect);
    const selectFrom = (target: HTMLElement) => {
      const event = new Event('beforexrselect', { bubbles: true, cancelable: true });
      if (target.dispatchEvent(event)) session.dispatchEvent(new Event('select'));
      return event.defaultPrevented;
    };
    expect(selectFrom(view)).toBe(false);
    expect(selectFrom(root)).toBe(false);      // the overlay's own background
    expect(selectFrom(hud)).toBe(false);       // a gap between the buttons
    expect(selectFrom(button)).toBe(true);
    expect(selectFrom(label)).toBe(true);      // and anything inside one
    expect(onSelect).toHaveBeenCalledTimes(3);
    unbind();
    expect(selectFrom(label)).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(3);
  });
});

describe('what the DOM overlay is allowed to paint', () => {
  it('takes the page\'s own surfaces out of the overlay for the life of the session', async () => {
    const f = fixture();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, {});
    expect(f.overlay.classList.contains(XR_OVERLAY_CLASS)).toBe(false);
    await prepared!.enter();
    // The overlay root is the page, composited over the camera. The render
    // canvas is in it, holding its last non-XR frame — the opaque studio
    // background — and painting it over the real world.
    expect(f.overlay.classList.contains(XR_OVERLAY_CLASS)).toBe(true);
    f.emit(WebXRState.NOT_IN_XR);
    expect(f.overlay.classList.contains(XR_OVERLAY_CLASS)).toBe(false);
    prepared!.dispose();
    f.engine.dispose();
  });

  it('leaves the page alone when the session was refused', async () => {
    const f = fixture();
    f.baseExperience.enterXRAsync.mockRejectedValue(new DOMException('no', 'NotSupportedError'));
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, {});
    await prepared!.enter();
    expect(f.overlay.classList.contains(XR_OVERLAY_CLASS)).toBe(false);
    prepared!.dispose();
    f.engine.dispose();
  });

  it('restores the page when the helper is disposed mid-session', async () => {
    const f = fixture();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, {});
    await prepared!.enter();
    prepared!.dispose();
    expect(f.overlay.classList.contains(XR_OVERLAY_CLASS)).toBe(false);
    f.engine.dispose();
  });
});

describe('holding the spot while the device learns the room', () => {
  it('asks the platform to hold the placed surface, and follows its corrections', async () => {
    const f = fixture();
    const onAnchorPose = vi.fn();
    const onSelectAnchor = vi.fn();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onAnchorPose, onSelectAnchor });
    await prepared!.enter();
    f.hit();
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(f.anchors.addAnchorPointUsingHitTestResultAsync).toHaveBeenCalledTimes(1));

    // ARCore revises where that spot is; the assembly has to go with it rather
    // than stay pinned to a reference space that moved underneath it.
    f.anchor.transformationMatrix = Matrix.Translation(1.05, 0, 2.1);
    f.anchors.onAnchorUpdatedObservable.notifyObservers(f.anchor);
    expect(onAnchorPose).toHaveBeenCalledTimes(1);
    expect(onAnchorPose.mock.calls[0][0].position[0]).toBeCloseTo(1.05, 3);
    expect(onAnchorPose.mock.calls[0][0].position[2]).toBeCloseTo(2.1, 3);

    // Another anchor's corrections are not ours to follow.
    f.anchors.onAnchorUpdatedObservable.notifyObservers({ ...f.anchor, id: 99 });
    expect(onAnchorPose).toHaveBeenCalledTimes(1);
    prepared!.dispose();
    f.engine.dispose();
  });

  it('still places when the device grants no anchors', async () => {
    const f = fixture();
    f.baseExperience.featuresManager.enableFeature = vi.fn((name: string) => {
      if (/anchor/i.test(name)) throw new Error('not supported');
      return f.hitTest;
    });
    const onSelectAnchor = vi.fn();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onSelectAnchor });
    await prepared!.enter();
    f.hit();
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).toHaveBeenCalledTimes(1);
    prepared!.dispose();
    f.engine.dispose();
  });
});
