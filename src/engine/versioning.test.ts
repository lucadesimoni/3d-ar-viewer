import { describe, expect, it } from 'vitest';
import {
  assemblyFingerprint,
  bomTotalMass,
  buildBom,
  compareRevisions,
  isRevisionNewer,
  partVersionLabel,
  revisionRelation,
} from './versioning';
import { gearbox } from '../data/gearbox';
import { equipmentRack } from '../data/equipmentRack';
import type { PartDef } from './types';

describe('compareRevisions', () => {
  it('orders letter revisions incl. rollover A..Z..AA', () => {
    expect(compareRevisions('A', 'B')).toBe(-1);
    expect(compareRevisions('C', 'A')).toBe(1);
    expect(compareRevisions('Z', 'AA')).toBe(-1);
    expect(compareRevisions('B', 'B')).toBe(0);
  });
  it('orders dotted numeric revisions', () => {
    expect(compareRevisions('1', '1.2')).toBe(-1);
    expect(compareRevisions('1.2.3', '1.2')).toBe(1);
    expect(compareRevisions('2', '1.9.9')).toBe(1);
  });
  it('is total and deterministic across mixed styles', () => {
    expect(compareRevisions('A', '1')).not.toBeNaN();
    expect(compareRevisions('A', '1')).toBe(-compareRevisions('1', 'A'));
  });
  it('isRevisionNewer agrees', () => {
    expect(isRevisionNewer('C', 'B')).toBe(true);
    expect(isRevisionNewer('B', 'C')).toBe(false);
  });
});

describe('revisionRelation', () => {
  it('detects a superseded (older) part — the dangerous shop-floor case', () => {
    expect(revisionRelation('C', 'B')).toBe('older');
    expect(revisionRelation('C', 'C')).toBe('match');
    expect(revisionRelation('C', 'D')).toBe('newer');
  });
  it('is incomparable across styles', () => {
    expect(revisionRelation('A', '1.2')).toBe('incomparable');
  });
});

describe('partVersionLabel', () => {
  it('formats SKU + revision', () => {
    const part = gearbox.parts.find((p) => p.id === 'housing')!;
    expect(partVersionLabel(part)).toBe('GBX-200 Rev C');
  });
});

describe('buildBom', () => {
  it('aggregates quantities per SKU+revision', () => {
    const bom = buildBom(gearbox);
    const bolts = bom.find((l) => l.sku === 'GBX-500');
    expect(bolts?.qty).toBe(4); // four housing bolts, one line
    expect(bom.every((l) => l.revision.length > 0)).toBe(true);
  });
  it('rolls up the large rack into aggregated line items', () => {
    const bom = buildBom(equipmentRack);
    expect(bom.length).toBeLessThan(equipmentRack.parts.length); // aggregated
    const bolts = bom.find((l) => l.sku === 'RK-500');
    expect(bolts?.qty).toBe(14 * 4); // 4 cage bolts × 14 bays
    expect(bomTotalMass(bom)).toBeGreaterThan(0);
  });
  it('splits two revisions of the same SKU into separate lines', () => {
    const parts: PartDef[] = [
      { id: 'a', name: 'Widget', sku: 'W-1', revision: 'A', mesh: { type: 'box', size: [1, 1, 1] }, targetPose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, connectors: [] },
      { id: 'b', name: 'Widget', sku: 'W-1', revision: 'B', mesh: { type: 'box', size: [1, 1, 1] }, targetPose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, connectors: [] },
    ];
    const bom = buildBom({ ...gearbox, parts });
    expect(bom.filter((l) => l.sku === 'W-1')).toHaveLength(2);
  });
});

describe('assemblyFingerprint', () => {
  it('is stable and 8 hex chars', () => {
    const a = assemblyFingerprint(gearbox);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(assemblyFingerprint(gearbox)).toBe(a);
  });
  it('changes when any part revision bumps', () => {
    const before = assemblyFingerprint(gearbox);
    const bumped = { ...gearbox, parts: gearbox.parts.map((p, i) => (i === 0 ? { ...p, revision: 'Z' } : p)) };
    expect(assemblyFingerprint(bumped)).not.toBe(before);
  });
  it('differs between the two sample assemblies', () => {
    expect(assemblyFingerprint(gearbox)).not.toBe(assemblyFingerprint(equipmentRack));
  });
});
