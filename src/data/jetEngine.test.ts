import { describe, expect, it } from 'vitest';
import { jetEngine, jetEngineAxis } from './jetEngine';
import { validateGraph, topoOrder, buildSequenceView } from '../engine/sequencer';
import { runDiagnostics } from '../engine/diagnostics';
import { clonePose } from '../engine/math';
import type { PlacementState, Pose } from '../engine/types';

const byId = new Map(jetEngine.parts.map((p) => [p.id, p]));
const nominal = () => {
  const placements = new Map<string, PlacementState>();
  for (const p of jetEngine.parts) placements.set(p.id, { partId: p.id, pose: clonePose(p.targetPose), status: 'placed' });
  return placements;
};
const { origin, direction: axis } = jetEngineAxis;
/** Position relative to the engine axis: how far along it, and the radial offset from it. */
function aroundAxis(p: [number, number, number]) {
  const v = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
  const along = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const radial = [v[0] - along * axis[0], v[1] - along * axis[1], v[2] - along * axis[2]];
  return { along, radial, r: Math.hypot(radial[0], radial[1], radial[2]) };
}

describe('the jet engine sample', () => {
  it('is the size the docs say', () => {
    expect(jetEngine.parts.length).toBe(50);
    expect(jetEngine.steps.length).toBe(16);
  });

  it('has a valid build graph, with every part installed in exactly one step', () => {
    expect(validateGraph(jetEngine)).toHaveLength(0);
    expect(topoOrder(jetEngine.steps)).toBeDefined();
    const installed = jetEngine.steps.flatMap((s) => s.partIds);
    expect(installed.length).toBe(new Set(installed).size);
    expect(new Set(installed)).toEqual(new Set(jetEngine.parts.map((p) => p.id)));
  });

  it('starts at the stand, with the fan blades locked until their disk is on', () => {
    const placements = nominal();
    for (const p of placements.values()) p.status = 'ghost';
    const view = buildSequenceView(jetEngine, placements, new Set(), 's1', []);
    const status = new Map(view.steps.map((s) => [s.step.id, s.status]));
    expect(status.get('s1')).toBe('active');
    expect(status.get('s14')).toBe('locked');
  });

  it('has a balanced fan: sixteen blades, evenly spaced, inside the case with tip clearance', () => {
    const blades = jetEngine.parts.filter((p) => p.groupId === 'fan-blades');
    expect(blades).toHaveLength(16);
    const sum = [0, 0, 0];
    const radials = blades.map((b) => aroundAxis(b.targetPose.position));
    for (const { radial } of radials) for (let k = 0; k < 3; k++) sum[k] += radial[k];
    expect(Math.hypot(sum[0], sum[1], sum[2])).toBeLessThan(1e-9);    // radial moments cancel
    // Evenly spaced: every blade's nearest neighbour is one pitch away.
    const pitch = (2 * Math.PI) / 16;
    for (const a of radials) {
      const gaps = radials.filter((b) => b !== a).map((b) => {
        const dot = (a.radial[0] * b.radial[0] + a.radial[1] * b.radial[1] + a.radial[2] * b.radial[2]) / (a.r * b.r);
        return Math.acos(Math.max(-1, Math.min(1, dot)));
      });
      expect(Math.min(...gaps)).toBeCloseTo(pitch, 9);
    }
    const fanCase = byId.get('fan-case')!;
    const caseBore = fanCase.mesh.type === 'tube' ? fanCase.mesh.radius - fanCase.mesh.wall : 0;
    const blade = blades[0];
    const tip = aroundAxis(blade.targetPose.position).r + (blade.mesh.type === 'box' ? blade.mesh.size[1] / 2 : 0);
    expect(caseBore - tip).toBeGreaterThanOrEqual(0.005);
  });

  it('is in colour: every part coloured, and the modules told apart', () => {
    for (const p of jetEngine.parts) expect(p.material?.color, p.id).toMatch(/^#[0-9a-f]{6}$/i);
    const colour = (id: string) => byId.get(id)!.material!.color;
    const modules = ['stand-base', 'fan-case', 'lpc-case', 'hpc-case', 'combustor-case', 'hpt-case', 'lpt-case',
      'exhaust-nozzle', 'agb', 'fan-blade-01', 'fuel-nozzle-1', 'lp-shaft'];
    expect(new Set(modules.map(colour)).size).toBe(modules.length);
    expect(new Set(jetEngine.parts.map((p) => p.material!.color)).size).toBeGreaterThanOrEqual(20);
  });

  it('exempts only parts whose rings are truly clear of each other — a real clash is still caught', () => {
    // Shaft inside the fan case: rings far apart, so declared clear.
    expect(byId.get('lp-shaft')!.clearanceWith).toContain('fan-case');
    // Spinner and shaft overlap radially, so they are not exempt — pushing the
    // spinner back onto the shaft end is reported.
    expect(byId.get('spinner')!.clearanceWith ?? []).not.toContain('lp-shaft');
    const placements = nominal();
    const spinner = placements.get('spinner')!;
    // 4 cm back along the axis: where it first sat, reaching into the shaft's end.
    const p = spinner.pose.position;
    const moved: Pose = { ...spinner.pose, position: [p[0] + 0.04 * axis[0], p[1] + 0.04 * axis[1], p[2] + 0.04 * axis[2]] };
    placements.set('spinner', { ...spinner, pose: moved });
    const diags = runDiagnostics({ assembly: jetEngine, placements, completedStepIds: new Set(jetEngine.steps.map((s) => s.id)) });
    expect(diags.some((d) => d.code === 'INTERFERENCE' && d.partIds.includes('spinner') && d.partIds.includes('lp-shaft'))).toBe(true);
  });

  it('lies side-on: its axis runs across the default view, level, at stand height', () => {
    expect(Math.abs(axis[0])).toBeCloseTo(1, 9);      // across the screen, not into it
    expect(axis[1]).toBeCloseTo(0, 9);
    expect(origin[1]).toBeCloseTo(1.0, 9);
    // Intake first: the fan disk is upstream of the LP turbine.
    const along = (id: string) => aroundAxis(byId.get(id)!.targetPose.position).along;
    expect(along('fan-disk')).toBeLessThan(along('lpt-disk-1'));
  });

  it('keeps every part out of the intake danger zone when built', () => {
    const diags = runDiagnostics({ assembly: jetEngine, placements: nominal(), completedStepIds: new Set(jetEngine.steps.map((s) => s.id)) });
    expect(diags.filter((d) => d.code === 'KEEP_OUT')).toEqual([]);
    expect(diags.filter((d) => d.code === 'INTERFERENCE')).toEqual([]);
  });
});
