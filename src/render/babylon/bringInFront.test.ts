import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SceneManager, floorSpotInView } from './SceneManager';
import { gearbox, jetEngine } from '../../data';
import type { XrHooks } from './xr';
import type { AssemblyDef, Pose } from '../../engine/types';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./xr', () => ({ prepareImmersiveAr: prepare }));

afterEach(() => vi.restoreAllMocks());

describe('a spot on the floor in view', () => {
  const eye = new Vector3(0, 1.3, 0);

  it('is where the view meets the floor', () => {
    // Looking 30 degrees down: the floor is 1.3 / tan(30°) = 2.25 m ahead.
    const view = new Vector3(0, -Math.sin(Math.PI / 6), Math.cos(Math.PI / 6));
    const spot = floorSpotInView(eye, view, 0, 0.5, 4);
    expect(spot.position[1]).toBe(0);
    expect(spot.position[2]).toBeCloseTo(1.3 / Math.tan(Math.PI / 6), 2);
  });

  it('never on the operator\'s feet, however steeply they look down', () => {
    const view = new Vector3(0, -0.99, 0.14).normalize();
    expect(floorSpotInView(eye, view, 0, 1.5, 4).position[2]).toBeCloseTo(2, 3);
  });

  it('looking level or up, straight ahead at the framed distance, on the floor', () => {
    const spot = floorSpotInView(eye, new Vector3(0, 0.3, 1).normalize(), 0.2, 0.5, 3);
    expect(spot.position).toEqual([0, 0.2, 3]);
  });

  it('never further than 5 m', () => {
    const view = new Vector3(0, -0.06, 1).normalize();     // nearly level: 21 m off
    expect(floorSpotInView(eye, view, 0, 0.5, 4).position[2]).toBe(5);
  });
});

async function inSession(assembly: AssemblyDef) {
  const hooks: XrHooks[] = [];
  prepare.mockImplementation(async (_scene: unknown, _overlay: unknown, callbacks: XrHooks) => {
    hooks.push(callbacks);
    return { enter: async () => ({ end: vi.fn(async () => {}) }), dispose: vi.fn() };
  });
  const manager = new SceneManager(document.createElement('canvas'), assembly, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });
  await manager.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
  await manager.startWebXr(vi.fn(), vi.fn());
  const hook = hooks[hooks.length - 1];
  hook.onStateChange?.(true);
  return { manager, hook };
}

const flat = (y: number): Pose => ({ position: [0, y, -1], rotation: [0, 0, 0, 1] });

describe('"Bring it in front" in a WebXR session', () => {
  it('stands a floor-standing assembly on the measured floor, wherever the phone points', async () => {
    const { manager, hook } = await inSession(jetEngine);
    const cam = manager.scene.activeCamera!;
    const floorY = cam.globalPosition.y - 1.25;
    for (let i = 0; i < 12; i++) hook.onReticle?.(flat(floorY));
    const pose = manager.bringInFront();
    // A device log had the jet engine 1.2-3.2 m underground, four times.
    expect(pose.position[1]).toBeCloseTo(floorY, 6);
  });

  it('leaves a bench assembly centred in view, as before', async () => {
    const { manager } = await inSession(gearbox);
    const pose = manager.bringInFront();
    const before = manager.computeAnchorInFront({ centreInView: true });
    expect(pose.position).toEqual(before.position);
  });
});
