import { describe, expect, it } from 'vitest';
import { ASSEMBLIES, gearbox } from '../data';
import { AssemblyImportError, parseAssembly } from './assemblyImport';

describe('external assembly import', () => {
  it.each(ASSEMBLIES)('accepts bundled assembly $id without sharing mutable data', (assembly) => {
    const imported = parseAssembly(JSON.stringify(assembly));
    expect(imported).toEqual(JSON.parse(JSON.stringify(assembly)));
    expect(parseAssembly(assembly)).toEqual(assembly);
    expect(imported.parts).not.toBe(assembly.parts);
    expect(imported.parts[0].targetPose).not.toBe(assembly.parts[0].targetPose);
  });

  it('retains PLM occurrence identities without collapsing repeated item numbers', () => {
    const item = gearbox.parts[0];
    const assembly = parseAssembly({
      ...gearbox,
      source: { system: 'teamcenter', itemId: 'ASM-1', revisionId: 'B' },
      parts: ['occ-1', 'occ-2'].map((id) => ({
        ...item, id, sku: 'ITEM-42', revision: 'A',
        source: { system: 'teamcenter', itemId: 'ITEM-42', revisionId: 'A', occurrenceId: id },
        connectors: [], clearanceWith: [],
      })),
      steps: [],
    });
    expect(assembly.source?.revisionId).toBe('B');
    expect(assembly.parts.map((p) => p.source?.occurrenceId)).toEqual(['occ-1', 'occ-2']);
    expect(assembly.parts.map((p) => p.sku)).toEqual(['ITEM-42', 'ITEM-42']);
  });

  it.each([
    ['malformed JSON', '{'],
    ['null root', null],
    ['missing parts', { ...gearbox, parts: undefined }],
    ['empty assembly', { ...gearbox, parts: [] }],
    ['duplicate occurrences', { ...gearbox, parts: [gearbox.parts[0], gearbox.parts[0]] }],
    ['invalid scale', { ...gearbox, parts: [{ ...gearbox.parts[0], mesh: { type: 'url', url: '/part.glb', scale: -1 } }] }],
    ['executable URL', { ...gearbox, quickLookUrl: 'javascript:alert(1)' }],
    ['embedded credentials', { ...gearbox, quickLookUrl: 'https://user:password@example.com/model.usdz' }],
    ['non-finite position', { ...gearbox, parts: [{ ...gearbox.parts[0], targetPose: { position: [NaN, 0, 0], rotation: [0, 0, 0, 1] } }] }],
    ['zero quaternion', { ...gearbox, parts: [{ ...gearbox.parts[0], targetPose: { position: [0, 0, 0], rotation: [0, 0, 0, 0] } }] }],
    ['dangling step', { ...gearbox, steps: [{ ...gearbox.steps[0], requires: ['missing'] }] }],
    ['cyclic instructions', { ...gearbox, steps: [{ ...gearbox.steps[0], requires: [gearbox.steps[0].id] }] }],
  ])('rejects %s with an actionable path', (_name, input) => {
    expect(() => parseAssembly(input)).toThrow(AssemblyImportError);
    expect(() => parseAssembly(input)).toThrow(/assembly/);
  });

  it('rejects dangling mate connector references', () => {
    const assembly = structuredClone(gearbox);
    const mate = assembly.steps.flatMap((s) => s.mates)[0];
    mate.a.connectorId = 'not-in-cad';
    expect(() => parseAssembly(assembly)).toThrow(/unknown connector.*not-in-cad/);
  });

  it('does not reinterpret sourceUnits as runtime coordinates', () => {
    const assembly = parseAssembly({ ...gearbox, sourceUnits: 'mm' });
    expect(assembly.parts[0].targetPose.position).toEqual(gearbox.parts[0].targetPose.position);
  });
});
