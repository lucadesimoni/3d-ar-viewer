import { describe, expect, it } from 'vitest';
import { runDiagnostics } from './diagnostics';
import { clonePose, connectorWorldFrame } from './math';
import { mateTargetFrame, solveSnapPose } from './snapping';
import { gearbox } from '../data/gearbox';
import type { PlacementState, Pose } from './types';

function placementsAllGhost(): Map<string, PlacementState> {
  const m = new Map<string, PlacementState>();
  for (const p of gearbox.parts) m.set(p.id, { partId: p.id, pose: clonePose(p.targetPose), status: 'ghost' });
  return m;
}

function place(m: Map<string, PlacementState>, id: string, pose?: Pose): void {
  const part = gearbox.parts.find((p) => p.id === id)!;
  m.set(id, { partId: id, pose: pose ?? clonePose(part.targetPose), status: 'placed' });
}

describe('runDiagnostics — sequence', () => {
  it('flags a part installed before its prerequisites', () => {
    const placements = placementsAllGhost();
    place(placements, 'input-shaft'); // requires s2 (housing) which is not placed/complete
    const diags = runDiagnostics({ assembly: gearbox, placements, completedStepIds: new Set() });
    expect(diags.some((d) => d.code === 'SEQUENCE_VIOLATION')).toBe(true);
  });

  it('is quiet when parts go in the right order', () => {
    const placements = placementsAllGhost();
    place(placements, 'baseplate');
    const diags = runDiagnostics({
      assembly: gearbox, placements, completedStepIds: new Set(['s1']),
    });
    expect(diags.some((d) => d.code === 'SEQUENCE_VIOLATION')).toBe(false);
  });
});

describe('runDiagnostics — swapped handed parts', () => {
  it('detects the left cap fitted in the right position', () => {
    const placements = placementsAllGhost();
    const left = gearbox.parts.find((p) => p.id === 'cap-left')!;
    const right = gearbox.parts.find((p) => p.id === 'cap-right')!;
    // Put the left cap where the right one belongs.
    place(placements, 'cap-left', clonePose(right.targetPose));
    place(placements, 'cap-right', clonePose(left.targetPose));
    const diags = runDiagnostics({ assembly: gearbox, placements, completedStepIds: new Set() });
    expect(diags.some((d) => d.code === 'MIRRORED_VARIANT')).toBe(true);
  });
});

describe('runDiagnostics — fit', () => {
  it('passes a correctly seated housing on the base plate', () => {
    const placements = placementsAllGhost();
    place(placements, 'baseplate');
    const housing = gearbox.parts.find((p) => p.id === 'housing')!;
    const base = gearbox.parts.find((p) => p.id === 'baseplate')!;
    const foot = housing.connectors.find((c) => c.id === 'foot')!;
    const seat = base.connectors.find((c) => c.id === 'housing-seat')!;
    const desired = mateTargetFrame(connectorWorldFrame(base.targetPose, seat));
    place(placements, 'housing', solveSnapPose(housing.targetPose, foot, desired));
    const diags = runDiagnostics({
      assembly: gearbox, placements, completedStepIds: new Set(['s1']),
    });
    const housingErrors = diags.filter(
      (d) => d.partIds.includes('housing') && d.severity === 'error' && d.code.startsWith('FIT'),
    );
    expect(housingErrors).toHaveLength(0);
  });

  it('flags a housing dropped 5 mm out of position', () => {
    const placements = placementsAllGhost();
    place(placements, 'baseplate');
    const housing = gearbox.parts.find((p) => p.id === 'housing')!;
    const off: Pose = {
      position: [housing.targetPose.position[0] + 0.005, housing.targetPose.position[1], housing.targetPose.position[2]],
      rotation: housing.targetPose.rotation,
    };
    place(placements, 'housing', off);
    const diags = runDiagnostics({
      assembly: gearbox, placements, completedStepIds: new Set(['s1']),
    });
    expect(diags.some((d) => d.code === 'FIT_POSITION' && d.partIds.includes('housing'))).toBe(true);
  });
});

describe('runDiagnostics — missing part on a signed-off step', () => {
  it('flags a completed step whose parts are not all fitted', () => {
    const placements = placementsAllGhost();
    const diags = runDiagnostics({
      assembly: gearbox, placements, completedStepIds: new Set(['s1']),
    });
    expect(diags.some((d) => d.code === 'MISSING_PART')).toBe(true);
  });
});
