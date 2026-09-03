import { describe, expect, it } from 'vitest';
import { topoOrder, validateGraph, buildSequenceView } from './sequencer';
import { runDiagnostics } from './diagnostics';
import { clonePose } from './math';
import { gearbox } from '../data/gearbox';
import type { AssemblyDef, PlacementState } from './types';

function ghosts(): Map<string, PlacementState> {
  const m = new Map<string, PlacementState>();
  for (const p of gearbox.parts) m.set(p.id, { partId: p.id, pose: clonePose(p.targetPose), status: 'ghost' });
  return m;
}

describe('topoOrder', () => {
  it('orders the gearbox steps respecting prerequisites', () => {
    const order = topoOrder(gearbox.steps);
    expect(order).toBeDefined();
    const idx = (id: string) => order!.indexOf(id);
    expect(idx('s1')).toBeLessThan(idx('s2'));
    expect(idx('s2')).toBeLessThan(idx('s3'));
    expect(idx('s5')).toBeLessThan(idx('s6'));
  });

  it('returns undefined on a cycle', () => {
    const cyclic: AssemblyDef = {
      ...gearbox,
      steps: [
        { ...gearbox.steps[0], id: 'a', requires: ['b'], partIds: [], mates: [] },
        { ...gearbox.steps[0], id: 'b', requires: ['a'], partIds: [], mates: [] },
      ],
    };
    expect(topoOrder(cyclic.steps)).toBeUndefined();
  });
});

describe('validateGraph', () => {
  it('accepts the shipped gearbox', () => {
    expect(validateGraph(gearbox)).toHaveLength(0);
  });

  it('reports an unknown prerequisite', () => {
    const bad: AssemblyDef = {
      ...gearbox,
      steps: [{ ...gearbox.steps[0], requires: ['does-not-exist'] }, ...gearbox.steps.slice(1)],
    };
    expect(validateGraph(bad).some((e) => /unknown step/.test(e))).toBe(true);
  });
});

describe('buildSequenceView', () => {
  it('marks the first step ready and later steps locked', () => {
    const placements = ghosts();
    const diags = runDiagnostics({ assembly: gearbox, placements, completedStepIds: new Set() });
    const view = buildSequenceView(gearbox, placements, new Set(), 's1', diags);
    const byId = new Map(view.steps.map((s) => [s.step.id, s]));
    expect(byId.get('s1')!.status).toBe('active');
    expect(byId.get('s6')!.status).toBe('locked');
    expect(view.progress).toBe(0);
  });
});
