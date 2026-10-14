import { beforeEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { alignAnchor, newAlignMemory } from './useArController';
import { useStore } from '../state/store';
import { clearLog, logEntries } from '../diagnostics/log';
import type { Pose } from '../engine/types';
import { composePose } from '../engine/math';
import type { SceneManager } from '../render/babylon/SceneManager';
import { assemblyOf, camera, H, K, picture, W, type Solid } from '../perception/testScene';

/** A cabinet with a box on it, seen from front left, as in the registration tests. */
const CABINET: Solid[] = [
  { mesh: { type: 'box', size: [0.8, 0.7, 0.4] }, at: new Vector3(0, 0.35, 0) },
  { mesh: { type: 'box', size: [0.3, 0.2, 0.25] }, at: new Vector3(0.15, 0.8, 0) },
];
const cam = camera(new Vector3(0.9, 1.3, 2.2), new Vector3(0, 0.35, 0));
const frame = picture(CABINET, cam);
const blank = () => new ImageData(new Uint8ClampedArray(W * H * 4).fill(128), W, H);

const off = (x: number, z: number, yawDeg: number): Pose => {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180);
  return { position: [x, 0, z], rotation: [q.x, q.y, q.z, q.w] };
};

/** Just enough of the renderer: the overlay drawn where the store says, seen through the picture's camera. */
const manager = {
  assemblyPose: () => useStore.getState().anchor,
  viewMatrix: () => cam.view,
  frameIntrinsics: () => K,
  partEdges: () => undefined,
} as unknown as SceneManager;

const looks = () => logEntries().filter((e) => e.message.startsWith('alignment'));

beforeEach(() => {
  useStore.getState().loadAssembly(assemblyOf(CABINET));
  useStore.getState().setArSettings({ alignToObject: true });
  useStore.getState().setAnchor(off(0.05, -0.04, 4), 0.6, 'floor');
  clearLog();
});

describe('lining the overlay up with the object', () => {
  it('moves an overlay placed a few centimetres off onto the object, and says so', () => {
    const memo = newAlignMemory();
    expect(alignAnchor(manager, frame, 0, memo)).toBe(true);
    const anchor = useStore.getState().anchor!;
    expect(Math.hypot(anchor.position[0], anchor.position[2])).toBeLessThan(0.012);
    expect(useStore.getState().arPlacement).toBe('floor');
    expect(memo.holding).toBe(true);
    const [entry] = looks();
    expect(entry.message).toBe('alignment moved the overlay');
    expect(entry.data).toMatchObject({ outcome: 'moved', holding: true });
    expect(entry.data!.cm as number).toBeGreaterThan(4);
  });

  it('then finds it already on the object, and leaves it be', () => {
    const memo = newAlignMemory();
    alignAnchor(manager, frame, 0, memo);
    const placed = useStore.getState().anchor;
    expect(alignAnchor(manager, frame, 5000, memo)).toBe(false);
    expect(useStore.getState().anchor).toBe(placed);
    expect(memo.holding).toBe(true);
  });

  it('looks every second and a half, not every frame', () => {
    const memo = newAlignMemory();
    alignAnchor(manager, blank(), 0, memo);
    alignAnchor(manager, frame, 500, memo);
    expect(useStore.getState().anchor).toEqual(off(0.05, -0.04, 4));
    expect(alignAnchor(manager, frame, 1600, memo)).toBe(true);
  });

  it('does nothing when switched off, or before anything is placed', () => {
    useStore.getState().setArSettings({ alignToObject: false });
    expect(alignAnchor(manager, frame, 0, newAlignMemory())).toBe(false);
    useStore.getState().setArSettings({ alignToObject: true });
    useStore.getState().setAnchor(undefined, 0, 'awaiting');
    expect(alignAnchor(manager, frame, 0, newAlignMemory())).toBe(false);
    expect(looks()).toHaveLength(0);
  });

  it('lets go of the object after three looks without it, and logs why', () => {
    const memo = newAlignMemory();
    alignAnchor(manager, frame, 0, memo);
    expect(memo.holding).toBe(true);
    clearLog();
    // The object has gone from view: a picture of a bare wall.
    const wall = picture([], cam);
    for (const t of [3000, 6000]) alignAnchor(manager, wall, t, memo);
    expect(memo.holding).toBe(true);
    alignAnchor(manager, wall, 9000, memo);
    expect(memo.holding).toBe(false);
    const logged = looks();
    expect(logged[0].message).toBe('alignment look');
    expect(logged.at(-1)!.data).toMatchObject({ holding: false });
    expect(useStore.getState().anchor!.position[0]).toBeCloseTo(0, 1);
  });

  it('on the shape detector\'s lock, keeps the move as a correction to it, so the detector can keep following', () => {
    const lock = off(0.05, -0.04, 4);
    useStore.getState().setAnchor(lock, 0.7, 'recognized');
    const memo = newAlignMemory();
    expect(alignAnchor(manager, frame, 0, memo)).toBe(true);
    const fitted = useStore.getState().anchor!;
    expect(useStore.getState().arPlacement).toBe('recognized');
    // The detector's next lock, corrected, lands where registration put it.
    const again = composePose(lock, memo.correction!);
    again.position.forEach((v, i) => expect(v).toBeCloseTo(fitted.position[i], 6));
    // A tap's placement has no detector under it: the move is the anchor itself.
    useStore.getState().setAnchor(lock, 0.6, 'floor');
    const tapped = newAlignMemory();
    alignAnchor(manager, frame, 0, tapped);
    expect(tapped.correction).toBeUndefined();
  });

  it('drops the correction when it lets go of the object', () => {
    useStore.getState().setAnchor(off(0.05, -0.04, 4), 0.7, 'recognized');
    const memo = newAlignMemory();
    alignAnchor(manager, frame, 0, memo);
    expect(memo.correction).toBeDefined();
    const wall = picture([], cam);
    for (const t of [3000, 6000, 9000]) alignAnchor(manager, wall, t, memo);
    expect(memo.correction).toBeUndefined();
  });

  it('only matches the parts already built, once steps are ticked', () => {
    const assembly = assemblyOf(CABINET);
    assembly.steps = [
      { id: 's1', title: 'Cabinet', instruction: '', partIds: ['p0'], requires: [], mates: [] },
      { id: 's2', title: 'Box on top', instruction: '', partIds: ['p1'], requires: ['s1'], mates: [] },
    ] as typeof assembly.steps;
    useStore.getState().loadAssembly(assembly);
    useStore.getState().setAnchor(off(0.05, -0.04, 4), 0.6, 'floor');
    useStore.getState().completeStep('s1');
    const memo = newAlignMemory();
    alignAnchor(manager, frame, 0, memo);
    expect(memo.model?.parts).toBe(1);
  });
});
