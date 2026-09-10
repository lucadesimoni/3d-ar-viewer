import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';
import type { Pose } from '../../engine/types';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./xr', () => ({ prepareImmersiveAr: prepare }));

afterEach(() => vi.restoreAllMocks());

const pose = (x: number, y: number, z: number): Pose => ({
  position: [x, y, z], rotation: [0, 0, 0, 1],
});

/**
 * A manager in a session with a placement made.
 *
 * `onPlace` writes the pose back through `setAnchor`, which is what the app
 * does: the store takes the placement and pushes it into the scene on the next
 * update. Half the behaviour under test here is what happens when it does that
 * again, and again, for reasons that have nothing to do with the anchor.
 */
async function placed() {
  const hooks: XrHooks[] = [];
  prepare.mockImplementation(async (_scene: unknown, _overlay: unknown, callbacks: XrHooks) => {
    hooks.push(callbacks);
    return { enter: async () => ({ end: vi.fn(async () => {}) }), dispose: vi.fn() };
  });
  const manager = new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });
  const store: { anchor?: Pose } = {};
  await manager.prepareWebXr({
    onPlace: (p) => { store.anchor = p; manager.setAnchor(p); },
    onEnd: vi.fn(),
  });
  await manager.startWebXr(
    (p) => { store.anchor = p; manager.setAnchor(p); }, vi.fn(),
  );
  const hook = hooks[hooks.length - 1];
  hook.onStateChange?.(true);
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  manager.setPlacementActive(true);
  vi.mocked(performance.now).mockReturnValue(5000);
  hook.onSelectAnchor?.(pose(0, 0, 2));
  return { manager, hook, store };
}

/** Where the assembly actually is, which is the only thing the operator sees. */
const where = (m: SceneManager): [number, number, number] => {
  const root = m.scene.getTransformNodeByName('assembly')!;
  return [root.position.x, root.position.y, root.position.z];
};

/**
 * Let the picture catch up.
 *
 * A correction is followed rather than teleported to, so where the assembly
 * *is* trails where the platform says it should be for a few frames. Twenty
 * closes a metre to well under a millimetre at 15% a frame.
 */
const settleGlide = (m: SceneManager, frames = 40): void => {
  for (let i = 0; i < frames; i++) m.scene.render();
};

describe('following the platform without shaking on its noise', () => {
  it('ignores reports that say the anchor is where it already was', async () => {
    const { manager, hook, store } = await placed();
    try {
      const start = where(manager);
      // Straight from the Android log: ~30 reports a second, the position
      // identical to three decimals for seconds at a time. Each one used to be
      // written through as a fresh placement.
      hook.onAnchorPose?.(pose(-0.132, -0.781, 1.597));
      for (let i = 0; i < 60; i++) hook.onAnchorPose?.(pose(-0.132, -0.781, 1.597));
      settleGlide(manager);
      expect(where(manager)).toEqual(start);

      // And the 1.19 m relocalisation at t=34454 goes through at once.
      hook.onAnchorPose?.(pose(-1.172, -0.185, 1.979));
      // Not there yet: a metre-and-a-bit arriving in one frame reads as a
      // fault rather than a correction, so it is followed over a few.
      expect(where(manager)[0]).not.toBeCloseTo(start[0] - 1.04, 2);
      settleGlide(manager);
      expect(where(manager)[0]).toBeCloseTo(start[0] - 1.04, 3);
      expect(where(manager)[1]).toBeCloseTo(start[1] + 0.596, 3);
      expect(where(manager)[2]).toBeCloseTo(start[2] + 0.382, 3);
      // The store still holds what the operator placed; the correction is the
      // same placement where it now is, and is not re-announced.
      expect(store.anchor?.position[2]).toBeCloseTo(start[2], 3);
    } finally {
      manager.dispose();
    }
  });

  it('starts measuring afresh at each new placement', async () => {
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(pose(0, 0, 2));
      hook.onAnchorPose?.(pose(0.5, 0, 2));
      // A second placement: the old anchor's travel must not be replayed onto it.
      vi.mocked(performance.now).mockReturnValue(9000);
      manager.setPlacementActive(true);
      vi.mocked(performance.now).mockReturnValue(13000);
      hook.onSelectAnchor?.(pose(0, 0, 3));
      const start = where(manager);
      hook.onAnchorPose?.(pose(0.5, 0, 2));
      settleGlide(manager);
      expect(where(manager)).toEqual(start);
      hook.onAnchorPose?.(pose(0.5, 0, 2.0005));
      settleGlide(manager);
      expect(where(manager)).toEqual(start);
    } finally {
      manager.dispose();
    }
  });
});

describe('the app pushing its own idea of the anchor back in', () => {
  it('does not undo the platform corrections on an unrelated store change', async () => {
    // The bug a real device log made visible. The store keeps the pose from the
    // tap; the platform's corrections move the assembly without announcing
    // themselves. The app calls `setAnchor(store.anchor)` on *every* store
    // change — so changing step pushed the tap pose back in and yanked the
    // assembly back by however far the platform had corrected since. In that
    // log the gap had reached 0.4 m by the time the operator changed step.
    const { manager, hook, store } = await placed();
    try {
      const start = where(manager);
      hook.onAnchorPose?.(pose(0, 0, 2));
      hook.onAnchorPose?.(pose(0.4, 0, 2));
      settleGlide(manager);
      expect(where(manager)[0]).toBeCloseTo(start[0] + 0.4, 3);

      // Next step, a part selected, a diagnostic recomputed: the same pose,
      // pushed in again, as it is on every single store change.
      manager.setAnchor(store.anchor);
      manager.setAnchor(store.anchor);
      expect(where(manager)[0]).toBeCloseTo(start[0] + 0.4, 3);
    } finally {
      manager.dispose();
    }
  });

  it('takes a pose the app really did change, and measures from it', async () => {
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(pose(0, 0, 2));
      hook.onAnchorPose?.(pose(0.4, 0, 2));

      // "Bring it here": a genuinely new pose from the app. It lands at once —
      // the operator asked for it — and abandons any correction in flight.
      manager.setAnchor(pose(1, 0, 1));
      expect(where(manager)).toEqual([1, 0, 1]);
      settleGlide(manager);
      expect(where(manager)).toEqual([1, 0, 1]);

      // The platform's next reports must move *this* pose, not drag the
      // assembly back to the spot the operator had already abandoned.
      hook.onAnchorPose?.(pose(0.4, 0, 2));
      settleGlide(manager);
      expect(where(manager)).toEqual([1, 0, 1]);
      hook.onAnchorPose?.(pose(0.4, 0, 2.5));
      settleGlide(manager);
      expect(where(manager)[2]).toBeCloseTo(1.5, 3);
    } finally {
      manager.dispose();
    }
  });
});

describe('how a correction arrives', () => {
  it('follows a relocalisation over a few frames instead of teleporting', async () => {
    // "When tap and swipe the assembly sometimes hops." A relocalisation is
    // the platform being right where we were wrong, so the assembly does have
    // to go — but a metre in one frame reads as a fault, not a correction. A
    // real device reported exactly that jump: 1.19 m.
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(pose(0, 0, 2));
      const start = where(manager);
      hook.onAnchorPose?.(pose(1.19, 0, 2));

      const first = where(manager)[0] - start[0];
      expect(first).toBeGreaterThan(0);          // it did set off
      expect(first).toBeLessThan(0.4);           // and it did not arrive
      let frames = 0;
      while (Math.abs(where(manager)[0] - (start[0] + 1.19)) > 0.001 && frames < 200) {
        manager.scene.render();
        frames++;
      }
      // Visually over well inside half a second at 30 fps, and finished: a
      // glide that stops a centimetre short is just a slower wrong answer.
      expect(frames).toBeLessThan(15);
      expect(where(manager)[0]).toBeCloseTo(start[0] + 1.19, 3);
    } finally {
      manager.dispose();
    }
  });

  it('lands a correction too small to see in the frame it arrives in', async () => {
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(pose(0, 0, 2));
      const start = where(manager);
      // Three millimetres: over the threshold that discards noise, under
      // anything an operator could watch happen.
      hook.onAnchorPose?.(pose(0.003, 0, 2));
      expect(where(manager)[0]).toBeCloseTo(start[0] + 0.003, 6);
    } finally {
      manager.dispose();
    }
  });
});
