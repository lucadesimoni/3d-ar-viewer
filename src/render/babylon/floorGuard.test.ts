import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Observable } from '@babylonjs/core/Misc/observable';
import { WebXRState } from '@babylonjs/core/XR/webXRTypes';
import { prepareImmersiveAr } from './xr';
import { clearLog, logEntries } from '../../diagnostics/log';

/**
 * Its own file on purpose.
 *
 * The reference-space ladder is module state — one refused entry demotes the
 * whole module from `local-floor` to `local` for the rest of the page — and
 * `local` has no floor at y = 0 to judge a hit against. Sharing a file with the
 * tests that exercise a refusal makes this depend on declaration order, which
 * is not a property anyone should have to remember.
 */

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
    onHitTestResultObservable: new Observable<{
      position: { x: number; y: number; z: number };
      rotationQuaternion: { x: number; y: number; z: number; w: number };
    }[]>(),
  };
  const sessionManager = {
    session,
    referenceSpace: {} as XRReferenceSpace,
    onXRSessionInit: new Observable<EventTarget>(),
    onXRFrameObservable: new Observable<XRFrame>(),
  };
  const emit = (state: WebXRState) => {
    baseExperience.state = state;
    baseExperience.onStateChangedObservable.notifyObservers(state);
  };
  const baseExperience = {
    state: WebXRState.NOT_IN_XR,
    onStateChangedObservable: new Observable<WebXRState>(),
    sessionManager,
    featuresManager: {
      enableFeature: vi.fn((name: string) => {
        if (/anchor/i.test(name)) throw new Error('not supported');
        return hitTest;
      }),
    },
    enterXRAsync: vi.fn(async () => {
      sessionManager.onXRSessionInit.notifyObservers(session);
      emit(WebXRState.IN_XR);
    }),
    exitXRAsync: vi.fn(async () => emit(WebXRState.NOT_IN_XR)),
  };
  createExperience.mockResolvedValue({ baseExperience, renderTarget: {}, dispose: vi.fn() });
  const hitAt = (x: number, y: number, z: number) =>
    hitTest.onHitTestResultObservable.notifyObservers([{
      position: { x, y, z },
      rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    }]);
  return { engine, scene, overlay, session, baseExperience, hitAt };
}

describe('what counts as a floor', () => {
  it('refuses a surface reported below the floor, and says so', async () => {
    // Three floor placements in one recorded session: −0.47 m, −2.92 m and
    // +0.05 m, with the phone held about a metre up. Two of the three were
    // metres underground, and the anchors made on them then wandered by up to
    // 4.2 m because they were pinned to nothing at all. In a `local-floor`
    // space the floor is y = 0 by definition; a floor beneath it is not one.
    clearLog();
    const f = fixture();
    const onReticle = vi.fn();
    const onSelectAnchor = vi.fn();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onReticle, onSelectAnchor });
    await prepared!.enter();

    // A real surface first, so the refusal is a transition and not the
    // clearing that happens at every session start.
    f.hitAt(0.2, 0.02, 1.7);
    expect(onReticle).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: [0.2, 0.02, 1.7] }),
    );
    f.hitAt(0.2, -2.924, 1.7);
    expect(onReticle).toHaveBeenLastCalledWith(undefined);
    f.session.dispatchEvent(new Event('select'));
    expect(onSelectAnchor).not.toHaveBeenCalled();
    expect(logEntries().some((e) => e.message.includes('below the floor'))).toBe(true);

    // Just below is still a floor: they are uneven, and the platform's own
    // estimate of where the floor is deserves a few centimetres of doubt.
    f.hitAt(0.2, -0.05, 1.7);
    expect(onReticle).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: [0.2, -0.05, 1.7] }),
    );
    prepared!.dispose();
    f.engine.dispose();
  });

  it('takes the platform at its word in a space with no floor to compare to', async () => {
    // `local` puts the origin where the session started, not on the floor, so
    // no height is implausible against it. Reached the way the app reaches it:
    // one refused entry demotes the ladder a rung.
    const f = fixture();
    const granted = f.baseExperience.enterXRAsync;
    f.baseExperience.enterXRAsync = vi.fn(async () => {
      throw new Error('NotSupportedError: local-floor');
    });
    const onReticle = vi.fn();
    const prepared = await prepareImmersiveAr(f.scene, f.overlay, { onReticle });
    expect(await prepared!.enter()).toBeUndefined();
    f.baseExperience.enterXRAsync = granted;
    await prepared!.enter();

    f.hitAt(0.2, -2.924, 1.7);
    expect(onReticle).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: [0.2, -2.924, 1.7] }),
    );
    prepared!.dispose();
    f.engine.dispose();
  });
});
