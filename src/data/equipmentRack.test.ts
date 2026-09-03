import { describe, expect, it } from 'vitest';
import { equipmentRack } from './equipmentRack';
import { validateGraph, topoOrder, buildSequenceView } from '../engine/sequencer';
import { runDiagnostics } from '../engine/diagnostics';
import { clonePose, connectorWorldFrame } from '../engine/math';
import { mateTargetFrame, solveSnapPose } from '../engine/snapping';
import type { PlacementState } from '../engine/types';

describe('equipmentRack (large sample)', () => {
  it('is genuinely large', () => {
    expect(equipmentRack.parts.length).toBeGreaterThan(100);
    expect(equipmentRack.steps.length).toBeGreaterThan(40);
  });

  it('has a valid, acyclic build graph with every part covered', () => {
    expect(validateGraph(equipmentRack)).toHaveLength(0);
    expect(topoOrder(equipmentRack.steps)).toBeDefined();
  });

  it('references only real parts and connectors in every mate', () => {
    const parts = new Map(equipmentRack.parts.map((p) => [p.id, p]));
    for (const step of equipmentRack.steps) {
      for (const m of step.mates) {
        const a = parts.get(m.a.partId);
        const b = parts.get(m.b.partId);
        expect(a, `mate ${m.id} moving part`).toBeDefined();
        expect(b, `mate ${m.id} fixed part`).toBeDefined();
        expect(a!.connectors.some((c) => c.id === m.a.connectorId)).toBe(true);
        expect(b!.connectors.some((c) => c.id === m.b.connectorId)).toBe(true);
      }
    }
  });

  it('produces no fit errors when every part is placed at nominal', () => {
    // Snap each moving part exactly onto its fixed counterpart, mate by mate,
    // then confirm the diagnostics are clean — proves the generated connectors
    // are geometrically consistent across all ~110 parts.
    const placements = new Map<string, PlacementState>();
    for (const p of equipmentRack.parts) {
      placements.set(p.id, { partId: p.id, pose: clonePose(p.targetPose), status: 'placed' });
    }
    const completed = new Set(equipmentRack.steps.map((s) => s.id));
    const diags = runDiagnostics({ assembly: equipmentRack, placements, completedStepIds: completed });
    const errors = diags.filter((d) => d.severity === 'error');
    // Nothing should error at nominal — no fit, no interference, no keep-out.
    expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(diags.some((d) => d.code === 'INTERFERENCE')).toBe(false);
    expect(diags.some((d) => d.code === 'KEEP_OUT')).toBe(false);
  });

  it('snapping a moving part onto its mate seats it in tolerance', () => {
    // Spot-check one representative joint end to end.
    const rail = equipmentRack.parts.find((p) => p.id === 'rail-01-L')!;
    const post = equipmentRack.parts.find((p) => p.id === 'post-fl')!;
    const mate = equipmentRack.steps
      .flatMap((s) => s.mates)
      .find((m) => m.a.partId === 'rail-01-L' && m.b.partId === 'post-fl')!;
    const conn = rail.connectors.find((c) => c.id === mate.a.connectorId)!;
    const fixedConn = post.connectors.find((c) => c.id === mate.b.connectorId)!;
    const desired = mateTargetFrame(connectorWorldFrame(post.targetPose, fixedConn));
    const snapped = solveSnapPose(rail.targetPose, conn, desired);
    // The solved pose should match the rail's own nominal.
    for (let i = 0; i < 3; i++) {
      expect(snapped.position[i]).toBeCloseTo(rail.targetPose.position[i], 4);
    }
  });

  it('starts with the base step ready and everything downstream locked', () => {
    const placements = new Map<string, PlacementState>();
    for (const p of equipmentRack.parts) {
      placements.set(p.id, { partId: p.id, pose: clonePose(p.targetPose), status: 'ghost' });
    }
    const diags = runDiagnostics({ assembly: equipmentRack, placements, completedStepIds: new Set() });
    const view = buildSequenceView(equipmentRack, placements, new Set(), 's-base', diags);
    const byId = new Map(view.steps.map((s) => [s.step.id, s]));
    expect(byId.get('s-base')!.status).toBe('active');
    expect(byId.get('s-panels')!.status).toBe('locked');
  });
});
