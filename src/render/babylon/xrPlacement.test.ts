import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Observable } from '@babylonjs/core/Misc/observable';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { WebXRState } from '@babylonjs/core/XR/webXRTypes';
import { PENDING_TAP_MS, XR_OVERLAY_CLASS, bindXrPlacement, prepareImmersiveAr } from './xr';
import { SETTLE_FRAMES, SETTLE_TIMEOUT_MS } from '../../engine/tracking/settle';
import { clearLog, logEntries } from '../../diagnostics/log';

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
    attached: true,
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
  const rawCamera = {
    onTexturesUpdatedObservable: new Observable<unknown>(),
    cameraIntrinsics: [{
      ax: 720, ay: 720, u0: 320, v0: 240, gamma: 0, width: 640, height: 480,
      viewportX: 0, viewportY: 0,
    }],
  };
  const viewerPose = { emulatedPosition: true };
  const frame = { getViewerPose: () => viewerPose } as unknown as XRFrame;
  const sessionManager = {
    session,
    referenceSpace: {} as XRReferenceSpace,
    onXRSessionInit: new Observable<EventTarget>(),
    onXRFrameObservable: new Observable<XRFrame>(),
  };
  const baseExperience = {
    state: WebXRState.NOT_IN_XR,
    onStateChangedObservable: new Observable<WebXRState>(),
    sessionManager,
    featuresManager: {
      enableFeature: vi.fn((name: string, ..._rest: unknown[]) => {
        if (/anchor/i.test(name)) return anchors;
        if (/camera/i.test(name)) return rawCamera;
        return hitTest;
      }),
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
  /** Pump frames as a tracking device would, so placement arms. */
  const frames = (n: number, emulated = false) => {
    viewerPose.emulatedPosition = emulated;
    for (let i = 0; i < n; i++) sessionManager.onXRFrameObservable.notifyObservers(frame);
  };
  /** A surface under the reticle and a platform that knows where it is. */
  const settled = () => { hit(); frames(SETTLE_FRAMES); };
  return {
    engine, scene, overlay, session, baseExperience, hitTest, anchors, anchor,
    rawCamera, emit, hit, frames, settled, viewerPose,
  };
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
    f.settled();
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
    f.settled();
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
    f.settled();
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).toHaveBeenCalledTimes(1);
    prepared!.dispose();
    f.engine.dispose();
  });
});

describe('waiting for the platform before taking a placement', () => {
  it('holds a tap taken while the device is still guessing, and honours it', async () => {
    const f = fixture();
    const onSelectAnchor = vi.fn();
    const onTracking = vi.fn();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onSelectAnchor, onTracking });
    await prepared!.enter();
    f.hit();
    // A surface is reported, but the pose is emulated: ARCore has not decided
    // where the floor is. Placing here is what put an anchor 78 cm below it.
    f.frames(SETTLE_FRAMES * 2, true);
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).not.toHaveBeenCalled();

    // Not discarded, though. A device log has a tap refused at 22 of the 30
    // frames it takes to settle — two tenths of a second early, from an
    // operator aiming at exactly the right spot. It lands the moment it can.
    f.frames(SETTLE_FRAMES);
    expect(onSelectAnchor).toHaveBeenCalledTimes(1);
    // And the app was told — from the first frame, so the HUD says what it is
    // waiting for instead of inviting a tap that will be swallowed.
    expect(onTracking.mock.calls.map(([s]) => s.reason)).toEqual(['settling', 'settled']);
    prepared!.dispose();
    f.engine.dispose();
  });

  it('places a held tap only once, and anchors it like any other', async () => {
    const f = fixture();
    const onSelectAnchor = vi.fn();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onSelectAnchor });
    await prepared!.enter();
    f.hit();
    f.frames(1, true);
    f.session.dispatchEvent(new Event('select'));
    f.frames(SETTLE_FRAMES * 3);
    expect(onSelectAnchor).toHaveBeenCalledTimes(1);
    // A held tap that placed without an anchor would drift away from a spot
    // an ordinary tap keeps hold of — one path, or two different placements.
    await vi.waitFor(() =>
      expect(f.anchors.addAnchorPointUsingHitTestResultAsync).toHaveBeenCalledTimes(1));
    prepared!.dispose();
    f.engine.dispose();
  });

  it('forgets a tap the operator has plainly given up on', async () => {
    const f = fixture();
    const onSelectAnchor = vi.fn();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onSelectAnchor });
    await prepared!.enter();
    f.hit();
    f.frames(1, true);
    f.session.dispatchEvent(new Event('select'));

    // Four seconds later they are aiming somewhere else entirely, and a
    // placement now would be the app acting on its own.
    now.mockReturnValue(PENDING_TAP_MS + 1);
    f.frames(SETTLE_FRAMES * 3);
    expect(onSelectAnchor).not.toHaveBeenCalled();
    prepared!.dispose();
    f.engine.dispose();
  });

  it('does not trap an operator whose device never settles', async () => {
    const f = fixture();
    const onSelectAnchor = vi.fn();
    const onTracking = vi.fn();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onSelectAnchor, onTracking });
    await prepared!.enter();
    f.hit();
    f.frames(1, true);
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).not.toHaveBeenCalled();

    now.mockReturnValue(SETTLE_TIMEOUT_MS + 1);
    f.frames(1, true);
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).toHaveBeenCalledTimes(1);
    expect(onTracking.mock.calls.map(([s]) => s.reason)).toEqual(['settling', 'timeout']);
    prepared!.dispose();
    f.engine.dispose();
  });

  it('starts the wait over for the next session', async () => {
    const f = fixture();
    const onSelectAnchor = vi.fn();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onSelectAnchor });
    await prepared!.enter();
    f.settled();
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).toHaveBeenCalledTimes(1);

    // A second session on the same helper is a fresh room as far as the
    // platform is concerned, and gets the same wait as the first.
    f.baseExperience.sessionManager.onXRSessionInit.notifyObservers(f.session);
    f.hit();
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).toHaveBeenCalledTimes(1);
    prepared!.dispose();
    f.engine.dispose();
  });
});

describe('saying why a session found no surface', () => {
  it('records the first surface of each session, once, with how long it took', async () => {
    // A device log has a second session in the same page load waiting 20
    // seconds for a surface where the first waited three. Without this line
    // "the room has no planes" and "our hit-test never came back" read alike.
    clearLog();
    const f = fixture();
    f.hitTest.attached = true;
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, {});
    await prepared!.enter();
    f.hit();
    f.hit();
    const first = logEntries().filter((e) => e.message === 'first surface found');
    expect(first).toHaveLength(1);
    expect(first[0].data?.attached).toBe(true);
    expect(typeof first[0].data?.waitedMs).toBe('number');

    // A second session asks the question again from scratch.
    f.baseExperience.sessionManager.onXRSessionInit.notifyObservers(f.session);
    f.hit();
    expect(logEntries().filter((e) => e.message === 'first surface found')).toHaveLength(2);
    prepared!.dispose();
    f.engine.dispose();
  });

  it('says whether the hit-test is even attached when it reports no surface', async () => {
    clearLog();
    const f = fixture();
    f.hitTest.attached = false;
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, {});
    await prepared!.enter();
    f.frames(1, true);
    const settling = logEntries().find((e) => e.message === 'tracking settling');
    expect(settling?.data?.hitTest).toBe(false);
    expect(settling?.data?.hasHit).toBe(false);
    prepared!.dispose();
    f.engine.dispose();
  });
});

describe('what the report can say about a session that has finished', () => {
  it('keeps the tracking state a session ended on, and clears it for the next', async () => {
    // An iPad log from inside the App Clip reported `settling, waitedMs: 41`
    // for a session that had run four and a half seconds: the state was
    // cleared on the way out, and the report fell back to the last reported
    // *change* — the first frame. The one question the log was taken to
    // answer went unanswered.
    const f = fixture();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, {});
    await prepared!.enter();
    f.settled();
    const { tracking: during } = await import('./xr');
    expect(during?.reason).toBe('settled');
    expect(during?.goodFrames).toBe(SETTLE_FRAMES);

    f.emit(WebXRState.NOT_IN_XR);
    const { tracking: after } = await import('./xr');
    expect(after?.reason).toBe('settled');
    expect(after?.goodFrames).toBe(SETTLE_FRAMES);

    // The next session starts from nothing, so its own wait is its own.
    f.baseExperience.sessionManager.onXRSessionInit.notifyObservers(f.session);
    const { tracking: next } = await import('./xr');
    expect(next).toBeUndefined();
    prepared!.dispose();
    f.engine.dispose();
  });
});

describe('seeing the camera image from inside a session', () => {
  it('asks for it optionally, and reports the intrinsics the platform gives', async () => {
    const f = fixture();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, {});
    const asked = f.baseExperience.featuresManager.enableFeature.mock.calls
      .find((args) => /camera/i.test(String(args[0])));
    expect(asked).toBeDefined();
    // The fifth argument is `required`, and it defaults to true. A session
    // refused because the phone will not hand over camera frames would trade
    // all of AR for a feature nothing yet depends on.
    expect(asked![4]).toBe(false);

    const { cameraAccess } = await import('./xr');
    expect(cameraAccess.requested).toBe(true);
    expect(cameraAccess.granted).toBe(false);   // nothing has arrived yet

    f.rawCamera.onTexturesUpdatedObservable.notifyObservers([]);
    const after = (await import('./xr')).cameraAccess;
    expect(after.granted).toBe(true);
    // Measured focal length, not one derived from an assumed field of view.
    expect(after.intrinsics?.ax).toBe(720);
    expect(after.intrinsics?.width).toBe(640);
    prepared!.dispose();
    f.engine.dispose();
  });

  it('enters the session even when the device refuses the camera image', async () => {
    const f = fixture();
    f.baseExperience.featuresManager.enableFeature = vi.fn((name: string, ..._rest: unknown[]) => {
      if (/camera/i.test(name)) throw new Error('camera-access not supported');
      return f.hitTest;
    });
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, {});
    expect(await prepared!.enter()).toBeDefined();
    const { cameraAccess } = await import('./xr');
    expect(cameraAccess.granted).toBe(false);
    expect(cameraAccess.error).toMatch(/not supported/);
    prepared!.dispose();
    f.engine.dispose();
  });
});
