import { describe, expect, it } from 'vitest';
import { ASSEMBLIES } from './index';
import { connectorWorldFrame } from '../engine/math';
import { mateTargetFrame, residualBetween, findSnapCandidates } from '../engine/snapping';
import { runDiagnostics } from '../engine/diagnostics';
import { clonePose } from '../engine/math';
import type { PlacementState, Pose } from '../engine/types';

/**
 * The invariant that was missing: EVERY mate of EVERY shipped assembly must be
 * satisfied when all its parts sit at their target poses. Without this, an
 * assembly can look fine on screen while every joint is tens of millimetres and
 * up to 180 degrees out — which silently disables snapping (candidates fall
 * outside the capture cone) and puts annotations in the wrong place.
 */
describe.each(ASSEMBLIES.map((a) => [a.name, a] as const))('%s — nominal geometry', (_name, assembly) => {
  const byId = new Map(assembly.parts.map((p) => [p.id, p]));

  it('satisfies every mate at nominal, within tolerance', () => {
    const tol = assembly.defaultTolerance;
    const bad: string[] = [];
    for (const step of assembly.steps) {
      for (const m of step.mates) {
        const A = byId.get(m.a.partId)!;
        const B = byId.get(m.b.partId)!;
        const ca = A.connectors.find((c) => c.id === m.a.connectorId)!;
        const cb = B.connectors.find((c) => c.id === m.b.connectorId)!;
        const r = residualBetween(
          connectorWorldFrame(A.targetPose, ca),
          mateTargetFrame(connectorWorldFrame(B.targetPose, cb)),
          ca.symmetry,
        );
        if (r.positionMm > tol.positionMm || r.angleDeg > tol.angleDeg) {
          bad.push(`${m.id}: ${r.positionMm.toFixed(2)}mm / ${r.angleDeg.toFixed(2)}deg`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('produces no diagnostics errors with every part at nominal', () => {
    const placements = new Map<string, PlacementState>();
    for (const p of assembly.parts) {
      placements.set(p.id, { partId: p.id, pose: clonePose(p.targetPose), status: 'placed' });
    }
    const diags = runDiagnostics({
      assembly, placements, completedStepIds: new Set(assembly.steps.map((s) => s.id)),
    });
    expect(diags.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
  });

  it('offers a snap for a part nudged a few millimetres off its joint', () => {
    // Pick the first mate whose fixed side is a real part, place that side, and
    // drop the moving part 5 mm off — snapping must catch it.
    const mate = assembly.steps.flatMap((s) => s.mates)[0];
    expect(mate, 'assembly should declare at least one mate').toBeDefined();
    const moving = byId.get(mate.a.partId)!;
    const fixed = byId.get(mate.b.partId)!;

    const sloppy: Pose = {
      position: [moving.targetPose.position[0] + 0.005, moving.targetPose.position[1], moving.targetPose.position[2]],
      rotation: [...moving.targetPose.rotation] as Pose['rotation'],
    };
    const candidates = findSnapCandidates(
      moving, sloppy, [mate], byId, new Map([[fixed.id, fixed.targetPose]]),
    );
    expect(candidates.length).toBeGreaterThan(0);

    // And accepting the snap must land it on nominal.
    const snapped = candidates[0].snappedPose;
    const ca = moving.connectors.find((c) => c.id === mate.a.connectorId)!;
    const cb = fixed.connectors.find((c) => c.id === mate.b.connectorId)!;
    const r = residualBetween(
      connectorWorldFrame(snapped, ca),
      mateTargetFrame(connectorWorldFrame(fixed.targetPose, cb)),
      ca.symmetry,
    );
    expect(r.positionMm).toBeLessThan(assembly.defaultTolerance.positionMm);
  });
});
