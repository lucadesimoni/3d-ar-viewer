import { beforeEach, describe, expect, it } from 'vitest';
import { updatePresence, type PresenceMemory } from './useArController';
import { useStore } from '../state/store';
import { kallax4x2Assembly } from '../data/kallax';
import { gearbox } from '../data/gearbox';
import type { SceneManager } from '../render/babylon/SceneManager';

const W = 120;
const H = 160;
const blank = () => {
  const data = new Uint8ClampedArray(W * H * 4).fill(128);
  return new ImageData(data, W, H);
};

/** Just enough of the renderer for a presence pass: every part is a box ahead. */
const manager = {
  frameIntrinsics: () => ({ fx: 150, fy: 150, cx: W / 2, cy: H / 2, width: W, height: H, fovDeg: 56, source: 'assumed' as const }),
  viewMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  partBox: () => ({ center: [0, 0, 2] as [number, number, number], halfExtents: [0.2, 0.2, 0.02] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] }),
  partOccluded: () => false,
} as unknown as SceneManager;

const anchor = { position: [0, 0, 2] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };

beforeEach(() => {
  useStore.getState().loadAssembly(kallax4x2Assembly);
  useStore.getState().setAnchor(anchor, 0.9, 'recognized');
});

describe('presence in the live loop', () => {
  it('says nothing about an assembly with nothing real to find', () => {
    useStore.getState().loadAssembly(gearbox);
    useStore.getState().setAnchor(anchor, 0.9, 'floor');
    updatePresence(manager, blank(), { evidence: new Map() });
    expect(useStore.getState().partPresence).toEqual({});
  });

  it('reports every part of the active step, and why it could not look', () => {
    updatePresence(manager, blank(), { evidence: new Map() });
    const state = useStore.getState();
    const step = state.assembly.steps.find((s) => s.id === state.activeStepId)!;
    expect(Object.keys(state.partPresence).sort()).toEqual([...step.partIds].sort());
    for (const p of Object.values(state.partPresence)) {
      expect(p.state).toBe('unknown');
      expect(p.reasons).toContain('blank-frame');
    }
  });

  it('keeps what it knows while tracking follows the object by millimetres', () => {
    const state = useStore.getState();
    const partId = state.assembly.steps.find((s) => s.id === state.activeStepId)!.partIds[0];
    const memo: PresenceMemory = { evidence: new Map(), anchor: state.anchor, placement: state.arPlacement, assembly: state.assembly };
    memo.evidence.set(partId, { presentHits: 3, absentHits: 0, state: 'present' });
    // A tracked lock hands the store a new pose every frame.
    useStore.getState().setAnchor({ ...anchor, position: [0.01, 0, 2] }, 0.9, 'recognized');
    updatePresence(manager, blank(), memo);
    expect(useStore.getState().partPresence[partId].state).toBe('present');
  });

  it('forgets what it saw through an anchor that has since moved', () => {
    const state = useStore.getState();
    const partId = state.assembly.steps.find((s) => s.id === state.activeStepId)!.partIds[0];
    const memo: PresenceMemory = { evidence: new Map(), anchor: state.anchor, placement: state.arPlacement, assembly: state.assembly };
    memo.evidence.set(partId, { presentHits: 3, absentHits: 0, state: 'present' });

    // Same anchor: a blank frame casts no vote, so what was known stands.
    updatePresence(manager, blank(), memo);
    expect(useStore.getState().partPresence[partId].state).toBe('present');

    // A new anchor puts every silhouette somewhere else.
    useStore.getState().setAnchor({ ...anchor, position: [0.5, 0, 2] }, 0.9, 'recognized');
    updatePresence(manager, blank(), memo);
    expect(useStore.getState().partPresence[partId].state).toBe('unknown');
  });
});
