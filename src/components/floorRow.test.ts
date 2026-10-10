import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyObjectAnchor } from './useArController';
import { useStore } from '../state/store';
import { kallax4x2Assembly } from '../data/kallax';
import { logEntries, clearLog } from '../diagnostics/log';
import type { ObjectAnchorTracker, ObjectObservation } from '../vision/objectAnchor';
import type { SceneManager } from '../render/babylon/SceneManager';
import type { GridTargetDef, Pose } from '../engine/types';

const target = kallax4x2Assembly.recognition as GridTargetDef;
const pitch = target.heightM / target.rows;

/** The face pose that puts the assembly's base at `baseY`, facing the camera. */
function faceAt(baseY: number): Pose {
  const [, fy, fz] = target.poseInAssembly.position;
  return { position: [0, baseY + fy, -2 - fz], rotation: target.poseInAssembly.rotation };
}

const reset = vi.fn();

function run(baseY: number, floorY: number | undefined): number | undefined {
  const obs: ObjectObservation = { pose: faceAt(baseY), confidence: 0.95, mode: 'tracked', reprojectionPx: 1 };
  const tracker = { update: () => obs, reset } as unknown as ObjectAnchorTracker;
  const manager = {
    frameIntrinsics: () => ({ fovDeg: 60 }),
    cameraToWorld: (p: Pose) => p,
    xrFloorY: () => floorY,
  } as unknown as SceneManager;
  applyObjectAnchor(tracker, {} as ImageData, 0, manager, target);
  return useStore.getState().anchor?.position[1];
}

describe('a recognised floor-standing shelf, against the measured floor', () => {
  beforeEach(() => {
    useStore.getState().loadAssembly(kallax4x2Assembly);
    clearLog();
    reset.mockClear();
  });

  it('comes down onto the floor from a row too high', () => {
    // The device session: floor tapped at 0.259, the lock's base at 0.648.
    expect(run(0.259 + pitch, 0.259)).toBeCloseTo(0.259, 3);
    expect(reset, 'a lock a row off is corrected, not dropped').not.toHaveBeenCalled();
    expect(logEntries().some((e) => e.message === 'recognition read a row off, moved' && e.data?.by === 'floor')).toBe(true);
  });

  it('comes up onto it from a row too low', () => {
    expect(run(0.187 - pitch, 0.187)).toBeCloseTo(0.187, 3);
  });

  it('is left where it is when it already stands on the floor', () => {
    expect(run(0.27, 0.259)).toBeCloseTo(0.27, 3);
  });

  it('is left where it is with no floor measured yet', () => {
    expect(run(0.259 + pitch, undefined)).toBeCloseTo(0.259 + pitch, 3);
  });

  it('is not moved to a pose the floor says is impossible', () => {
    // The session's bad bursts: 24 cm up, no row explains it.
    run(0.27, 0.259);
    expect(run(0.496, 0.259), 'stays at the last good pose').toBeCloseTo(0.27, 3);
    expect(logEntries().some((e) => e.message === 'recognition off the floor, ignored')).toBe(true);
    expect(reset, 'and the lock that produced it is dropped').toHaveBeenCalledTimes(1);
  });

  it('is left where it is for something built on a bench, not the floor', () => {
    useStore.getState().loadAssembly({ ...kallax4x2Assembly, workSurfaceM: 0.9 });
    expect(run(0.259 + pitch, 0.259)).toBeCloseTo(0.259 + pitch, 3);
  });
});
