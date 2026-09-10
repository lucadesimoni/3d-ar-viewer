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
 * update, and on every update after that.
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

/** And which way it faces, as a quaternion. */
const facing = (m: SceneManager): [number, number, number, number] => {
  const q = m.scene.getTransformNodeByName('assembly')!.rotationQuaternion!;
  return [q.x, q.y, q.z, q.w];
};

/** Frames, in case anything were still moving of its own accord. */
const settle = (m: SceneManager, frames = 40): void => {
  for (let i = 0; i < frames; i++) m.scene.render();
};

describe('placed is placed', () => {
  it('is not moved by anything the platform says about the spot', async () => {
    // The rule the operator asked for, after five sessions of logs: once it is
    // positioned it stays exactly where it was put, unless they press "Move" or
    // it snaps onto something recognised. The platform re-estimates that spot
    // after every single touch of the screen — thirteen taps in one recorded
    // session, thirteen moves, sixty to seventy milliseconds later each time —
    // and from the operator's side that is "every tap repositions it".
    const { manager, hook } = await placed();
    try {
      const start = where(manager);
      const heading = facing(manager);

      // Every jump three different sessions actually reported.
      const reported: Pose[] = [
        pose(0, 0, 2),
        pose(-1.172, -0.185, 1.979),        // the 1.19 m relocalisation, 9 Sept
        pose(0.01, -0.056, 0.804),          // 0.409 m, one tap later
        pose(0.394, -0.044, 0.777),
        ...[0.087, 0.114, 0.138, 0.156, 0.259, 0.305]   // the 22 cm climb
          .map((y) => pose(0.061, y, 0.806)),
      ];
      for (const report of reported) {
        for (let i = 0; i < 20; i++) hook.onAnchorPose?.(report);
        settle(manager);
      }

      expect(where(manager)).toEqual(start);
      expect(facing(manager)).toEqual(heading);
    } finally {
      manager.dispose();
    }
  });

  it('is not moved by the app pushing the same anchor back in', async () => {
    // `setAnchor(store.anchor)` runs on every store change — a step, a
    // selection, a diagnostic recomputed. It must be a no-op when the pose has
    // not changed, or the assembly twitches on unrelated interactions.
    const { manager, store } = await placed();
    try {
      const start = where(manager);
      for (let i = 0; i < 10; i++) manager.setAnchor(store.anchor);
      expect(where(manager)).toEqual(start);
    } finally {
      manager.dispose();
    }
  });
});

describe('the two things that may still move it', () => {
  it('takes a new pose from the app at once, and keeps it', async () => {
    // "Move", and a snap onto something recognised, both arrive here. They are
    // the operator's decision, or evidence about a real object — the two cases
    // the rule names — and neither is eased into or second-guessed.
    const { manager, hook } = await placed();
    try {
      manager.setAnchor(pose(1, 0.5, 1));
      expect(where(manager)).toEqual([1, 0.5, 1]);

      // And the platform cannot drag it back off the new spot either.
      for (const p of [pose(0, 0, 2), pose(0.4, 0, 2), pose(-1.1, 0.3, 3)]) {
        for (let i = 0; i < 20; i++) hook.onAnchorPose?.(p);
      }
      settle(manager);
      expect(where(manager)).toEqual([1, 0.5, 1]);
    } finally {
      manager.dispose();
    }
  });

  it('takes a second placement from a tap', async () => {
    const { manager, hook } = await placed();
    try {
      const first = where(manager);
      vi.mocked(performance.now).mockReturnValue(9000);
      manager.setPlacementActive(true);
      vi.mocked(performance.now).mockReturnValue(13000);
      hook.onSelectAnchor?.(pose(0, 0, 3));
      expect(where(manager)).not.toEqual(first);
    } finally {
      manager.dispose();
    }
  });

  it('clears back to the origin when the anchor goes', async () => {
    const { manager } = await placed();
    try {
      manager.setAnchor(undefined);
      expect(where(manager)).toEqual([0, 0, 0]);
    } finally {
      manager.dispose();
    }
  });
});
