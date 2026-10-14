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

/**
 * A frame with the part drawn where the box projects (±15 px around the
 * centre at 2 m and f = 150), on a lightly textured ground: sharp, not blank,
 * and edges along the outline, so the edge check votes "present".
 */
const busy = () => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= 45 && x < 75 && y >= 65 && y < 95;
      const v = (inside ? 230 : 40) + (((x * 7 + y * 13) % 5) - 2) * 6;
      const i = (y * W + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return new ImageData(data, W, H);
};

/** A stand-in for the trained model: answers `p` for every crop, when released. */
function fakeModel(p: number) {
  let release: () => void = () => undefined;
  const model = {
    ready: true,
    info: { thresholds: { present: 0.8, absent: 0.2 } },
    calls: 0,
    score: (crops: unknown[]) => {
      model.calls++;
      return new Promise<number[]>((ok) => { release = () => ok(crops.map(() => p)); });
    },
    release: () => release(),
  };
  return model;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('presence with the trained model', () => {
  const firstPart = () => {
    const st = useStore.getState();
    return st.assembly.steps.find((s) => s.id === st.activeStepId)!.partIds[0];
  };

  it('settles a part when the model and the edges agree, and keeps the score', async () => {
    const model = fakeModel(0.95);
    const memo = { evidence: new Map(), model } as unknown as PresenceMemory;
    for (let i = 0; i < 3; i++) {
      updatePresence(manager, busy(), memo);
      model.release(); await settle();
    }
    const p = useStore.getState().partPresence[firstPart()];
    expect(p.state).toBe('present');
    expect(p.score).toBeCloseTo(0.95);
  });

  it('casts no vote when the model contradicts the edges', async () => {
    const model = fakeModel(0.02);
    const memo = { evidence: new Map(), model } as unknown as PresenceMemory;
    for (let i = 0; i < 4; i++) {
      updatePresence(manager, busy(), memo);
      model.release(); await settle();
    }
    // The part is drawn on its outline: the edge check says present.
    const p = useStore.getState().partPresence[firstPart()];
    expect(p.coverage).toBeGreaterThanOrEqual(0.5);
    expect(p.state).toBe('unknown');
  });

  it('asks one question at a time, and drops an answer asked through an anchor that has moved', async () => {
    const model = fakeModel(0.95);
    const memo = { evidence: new Map(), model } as unknown as PresenceMemory;
    updatePresence(manager, busy(), memo);
    updatePresence(manager, busy(), memo);
    expect(model.calls).toBe(1);
    useStore.getState().setAnchor({ ...anchor, position: [0.5, 0, 2] }, 0.9, 'recognized');
    updatePresence(manager, busy(), memo); // resets the evidence; the model is still busy
    model.release(); await settle();
    expect(memo.evidence.get(firstPart())).toBeUndefined();
  });
});
