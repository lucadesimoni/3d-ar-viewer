import { describe, expect, it } from 'vitest';
import { classifyRecognition, type LabelInfo } from './verdict';
import type { Track } from './tracking';

const track = (id: number, label: string, score = 0.8): Track => ({
  id, label, classId: id, score,
  box: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
  hits: 5, misses: 0, age: 5, confirmed: true,
});

const info = (expected: string[], known: [string, string][]): LabelInfo => ({
  expected: new Set(expected),
  known: new Map(known),
});

const KNOWN: [string, string][] = [
  ['cap-left', 'Bearing cap LEFT'],
  ['cap-right', 'Bearing cap RIGHT'],
  ['housing', 'Gear housing'],
];

describe('classifyRecognition', () => {
  it('is correct (green) when the expected part is recognised', () => {
    const r = classifyRecognition([track(1, 'cap-left')], info(['cap-left'], KNOWN));
    expect(r.verdict).toBe('correct');
    expect(r.objects[0].status).toBe('match');
    expect(r.objects[0].name).toBe('Bearing cap LEFT');
  });

  it('is wrong (red) when a different known part is in view', () => {
    const r = classifyRecognition([track(1, 'cap-right')], info(['cap-left'], KNOWN));
    expect(r.verdict).toBe('wrong');
    expect(r.objects[0].status).toBe('mismatch');
    expect(r.wrongName).toBe('Bearing cap RIGHT');
  });

  it('flags an unknown detection amber and stays searching', () => {
    const r = classifyRecognition([track(1, 'coffee-mug')], info(['cap-left'], KNOWN));
    expect(r.verdict).toBe('searching');
    expect(r.objects[0].status).toBe('unknown');
  });

  it('prefers the wrong-part verdict even when the right part is also seen', () => {
    const r = classifyRecognition(
      [track(1, 'cap-left'), track(2, 'cap-right', 0.9)],
      info(['cap-left'], KNOWN),
    );
    expect(r.verdict).toBe('wrong');
    expect(r.wrongLabel).toBe('cap-right');
  });

  it('reports searching when nothing is recognised', () => {
    const r = classifyRecognition([], info(['cap-left'], KNOWN));
    expect(r.verdict).toBe('searching');
    expect(r.objects).toHaveLength(0);
  });
});
