import { describe, expect, it } from 'vitest';
import {
  classify,
  DEFAULT_TOLERANCE,
  evaluateMate,
  findSnapCandidates,
  residualBetween,
  solveSnapPose,
} from './snapping';
import { composePose, connectorLocalFrame, connectorWorldFrame } from './math';
import { mateTargetFrame } from './snapping';
import type { Connector, MateDef, PartDef, Pose } from './types';

const I: Pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

const pin: Connector = {
  id: 'pin', kind: 'pin', position: [0, 0, 0.05], axis: [0, 0, 1], up: [0, 1, 0],
  accepts: ['socket'], symmetry: 1, engagementDepth: 0.02,
};
const socket: Connector = {
  id: 'sock', kind: 'socket', position: [0, 0, 0], axis: [0, 0, -1], up: [0, 1, 0],
  accepts: ['pin'], engagementDepth: 0.02,
};

const shaft: PartDef = {
  id: 'shaft', name: 'Shaft', mesh: { type: 'cylinder', radius: 0.01, height: 0.1 },
  targetPose: I, connectors: [pin],
};
const block: PartDef = {
  id: 'block', name: 'Block', mesh: { type: 'box', size: [0.1, 0.1, 0.1] },
  targetPose: { position: [0, 0, 0.2], rotation: [0, 0, 0, 1] }, connectors: [socket],
};
const mate: MateDef = {
  id: 'm', a: { partId: 'shaft', connectorId: 'pin' }, b: { partId: 'block', connectorId: 'sock' }, type: 'insert',
};

describe('residualBetween', () => {
  it('is zero for coincident frames', () => {
    const r = residualBetween(I, I);
    expect(r.positionMm).toBeCloseTo(0, 6);
    expect(r.angleDeg).toBeCloseTo(0, 6);
  });

  it('splits a pure axial offset from a lateral one', () => {
    const axial = residualBetween({ position: [0, 0, 0.003], rotation: [0, 0, 0, 1] }, I);
    expect(axial.axialMm).toBeCloseTo(3, 4);
    expect(axial.lateralMm).toBeCloseTo(0, 4);

    const lateral = residualBetween({ position: [0.002, 0, 0], rotation: [0, 0, 0, 1] }, I);
    expect(lateral.lateralMm).toBeCloseTo(2, 4);
    expect(lateral.axialMm).toBeCloseTo(0, 4);
  });

  it('ignores a roll that symmetry makes equivalent', () => {
    const quarter: Pose = { position: [0, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] };
    const withSym = residualBetween(quarter, I, 4);
    expect(withSym.rollDeg).toBeCloseTo(0, 3);
    const withoutSym = residualBetween(quarter, I, 1);
    expect(withoutSym.rollDeg).toBeGreaterThan(80);
  });
});

describe('classify', () => {
  it('bands position and angle into ok/warn/fail', () => {
    const base = { axialMm: 0, lateralMm: 0, tiltDeg: 0, rollDeg: 0, angleDeg: 0 };
    expect(classify({ ...base, positionMm: 0.2 }, DEFAULT_TOLERANCE)).toBe('ok');
    expect(classify({ ...base, positionMm: 1.2 }, DEFAULT_TOLERANCE)).toBe('warn');
    expect(classify({ ...base, positionMm: 5 }, DEFAULT_TOLERANCE)).toBe('fail');
  });
});

describe('evaluateMate', () => {
  it('passes when the pin is fully seated in the socket', () => {
    // Move the shaft so its pin frame lands exactly on the socket's mate target.
    const desired = mateTargetFrame(connectorWorldFrame(block.targetPose, socket));
    const snapped = solveSnapPose(shaft.targetPose, pin, desired);
    const ev = evaluateMate(mate, shaft, snapped, block, block.targetPose, DEFAULT_TOLERANCE);
    expect(ev).toBeDefined();
    expect(ev!.status).toBe('ok');
    expect(ev!.engaged).toBe(true);
    expect(ev!.unseated).toBe(false);
  });

  it('flags an unseated part that is engaged but short of depth', () => {
    const desired = mateTargetFrame(connectorWorldFrame(block.targetPose, socket));
    const seated = solveSnapPose(shaft.targetPose, pin, desired);
    // Back the shaft off along its axis by 3 mm.
    const backed: Pose = {
      position: [seated.position[0], seated.position[1], seated.position[2] - 0.003],
      rotation: seated.rotation,
    };
    const ev = evaluateMate(mate, shaft, backed, block, block.targetPose, DEFAULT_TOLERANCE);
    expect(ev!.engaged).toBe(true);
    expect(ev!.unseated).toBe(true);
  });

  it('returns undefined for a mate naming a missing connector', () => {
    const bad: MateDef = { ...mate, a: { partId: 'shaft', connectorId: 'nope' } };
    expect(evaluateMate(bad, shaft, I, block, block.targetPose, DEFAULT_TOLERANCE)).toBeUndefined();
  });
});

describe('findSnapCandidates', () => {
  const parts = new Map([[shaft.id, shaft], [block.id, block]]);
  const poses = new Map([[block.id, block.targetPose]]);

  it('captures a shaft brought near the joint and ranks it', () => {
    // Pin points +Z at identity; present the shaft near the seat, lightly tilted.
    const near: Pose = { position: [0.001, 0.001, 0.15], rotation: [0.02, 0, 0, 0.9998] };
    const candidates = findSnapCandidates(shaft, near, [mate], parts, poses);
    expect(candidates.length).toBe(1);
    // Accepting the snap should yield an in-tolerance seat.
    const ev = evaluateMate(mate, shaft, candidates[0].snappedPose, block, block.targetPose, DEFAULT_TOLERANCE);
    expect(ev!.status).toBe('ok');
  });

  it('offers nothing when the shaft is out of capture range', () => {
    const far: Pose = { position: [0.5, 0.5, 0.5], rotation: [0, 0, 0, 1] };
    expect(findSnapCandidates(shaft, far, [mate], parts, poses)).toHaveLength(0);
  });

  it('does not offer a snap whose installed side is not yet placed', () => {
    const near: Pose = { position: [0.001, 0, 0.15], rotation: [0, 0, 0, 1] };
    expect(findSnapCandidates(shaft, near, [mate], parts, new Map())).toHaveLength(0);
  });
});

describe('solveSnapPose', () => {
  it('picks the nearest symmetric roll rather than spinning through 90°', () => {
    const hex: Connector = { ...pin, symmetry: 6 };
    const part: PartDef = { ...shaft, connectors: [hex] };
    const desired = mateTargetFrame(connectorWorldFrame(block.targetPose, socket));
    // Present the part rolled a little; the solved pose should barely rotate it.
    const rolled: Pose = { position: part.targetPose.position, rotation: [0, 0, 0.05, Math.sqrt(1 - 0.0025)] };
    const solved = solveSnapPose(rolled, hex, desired);
    const localFrame = connectorLocalFrame(hex);
    const solvedConnector = composePose(solved, localFrame);
    const r = residualBetween(solvedConnector, desired, hex.symmetry);
    expect(r.positionMm).toBeLessThan(0.1);
  });
});
