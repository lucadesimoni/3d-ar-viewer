import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { SceneManager } from './SceneManager';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';
import type { Pose } from '../../engine/types';
import { logEntries } from '../../diagnostics/log';

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

describe('following the platform, within bounds', () => {
  const offset = (m: SceneManager, start: [number, number, number]) => {
    const [x, y, z] = where(m);
    return Math.hypot(x - start[0], y - start[1], z - start[2]);
  };
  const atMs = (ms: number) => vi.mocked(performance.now).mockReturnValue(ms);
  const moved = () => logEntries().filter((e) => e.message === 'the platform moved the anchor');

  it('takes a small correction — the floor learned better — smoothly, not at once', async () => {
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(pose(0, 0, 2));
      const start = where(manager);
      atMs(10_000);
      hook.onAnchorPose?.(pose(0.05, 0, 2));          // 5 cm, the size device logs showed
      expect(moved().at(-1)?.data).toMatchObject({ followed: true });
      atMs(10_150); manager.scene.render();
      expect(offset(manager, start)).toBeCloseTo(0.025, 3);   // halfway, eased
      atMs(10_400); manager.scene.render();
      expect(offset(manager, start)).toBeCloseTo(0.05, 4);
    } finally {
      manager.dispose();
    }
  });

  it('declines a step too large to be refinement, and says why', async () => {
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(pose(0, 0, 2));
      const start = where(manager);
      atMs(10_000);
      hook.onAnchorPose?.(pose(-1.172, -0.185, 1.979));   // the 1.19 m relocalisation, 9 Sept
      atMs(11_000); settle(manager);
      expect(where(manager)).toEqual(start);
      expect(moved().at(-1)?.data).toMatchObject({ followed: false, why: 'step too large' });
    } finally {
      manager.dispose();
    }
  });

  it('never carries it more than 15 cm off its spot, step by small step', async () => {
    // Every jump three sessions reported, ending in the 22 cm climb in 2-10 cm
    // steps: the large ones declined, the climb taken only as far as 15 cm.
    const { manager, hook } = await placed();
    try {
      const start = where(manager);
      const heading = facing(manager);
      const reported: Pose[] = [
        pose(0, 0, 2),
        pose(-1.172, -0.185, 1.979),
        pose(0.01, -0.056, 0.804),
        pose(0.394, -0.044, 0.777),
        ...[0.087, 0.114, 0.138, 0.156, 0.259, 0.305].map((y) => pose(0.061, y, 0.806)),
      ];
      let t = 10_000;
      for (const report of reported) {
        atMs(t);
        for (let i = 0; i < 20; i++) hook.onAnchorPose?.(report);
        t += 1000;
        atMs(t);
        settle(manager);
      }
      expect(offset(manager, start)).toBeLessThanOrEqual(0.15 + 1e-6);
      expect(moved().some((e) => e.data?.why === 'too far from where it was placed')).toBe(true);
      // Upright and facing the same way: only heading is ever taken, and none was reported.
      facing(manager).forEach((v, i) => expect(v).toBeCloseTo(heading[i], 6));
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

describe('what the log says about the platform anchor', () => {
  const moves = () => logEntries().filter((e) => e.message === 'the platform moved the anchor').length;

  it('reports a big move of the anchor a tap placed the assembly on', async () => {
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(pose(0, 0, 2));
      const before = moves();
      hook.onAnchorPose?.(pose(0.9, 0, 2));
      expect(moves() - before).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('says nothing about it once the assembly has been put somewhere else', async () => {
    // A device log: "moved the anchor by 0.97 m" at a tap's floor spot, twenty
    // seconds after "Bring it in front" had moved the assembly off it.
    const { manager, hook } = await placed();
    try {
      hook.onAnchorPose?.(pose(0, 0, 2));
      manager.setAnchor(pose(0.6, 0.7, 0));          // brought in front
      const before = moves();
      hook.onAnchorPose?.(pose(0, 0, 2));
      hook.onAnchorPose?.(pose(0.9, 0, 2));
      expect(moves() - before).toBe(0);
    } finally {
      manager.dispose();
    }
  });
});

describe('which taps the platform is asked to hold', () => {
  it('declines a tap while placement is not armed, so no anchor is made for it', async () => {
    const { manager, hook } = await placed();
    try {
      expect(hook.onSelectAnchor?.(pose(0.3, 0, 1.8))).toBe(false);
      manager.setPlacementActive(true);
      vi.mocked(performance.now).mockReturnValue(9000);
      expect(hook.onSelectAnchor?.(pose(0.3, 0, 1.8))).toBe(true);
    } finally {
      manager.dispose();
    }
  });
});
