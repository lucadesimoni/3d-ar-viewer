import { describe, expect, it } from 'vitest';
import { ClassificationVoter, DetectionTracker } from './tracking';
import type { Detection } from './onnx';

const det = (classId: number, box: Detection['box'], score = 0.8): Detection => ({
  label: `c${classId}`, classId, score, box,
});
const box = (x: number, y: number) => ({ x, y, w: 0.2, h: 0.2 });

describe('DetectionTracker', () => {
  it('confirms a track only after minHits consistent frames', () => {
    const tr = new DetectionTracker({ minHits: 3, iouThreshold: 0.3, smoothing: 0.5 });
    expect(tr.update([det(0, box(0.1, 0.1))])).toHaveLength(0); // hit 1
    expect(tr.update([det(0, box(0.11, 0.1))])).toHaveLength(0); // hit 2
    const confirmed = tr.update([det(0, box(0.12, 0.1))]); // hit 3
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].classId).toBe(0);
  });

  it('smooths the box across frames (EMA)', () => {
    const tr = new DetectionTracker({ minHits: 1, smoothing: 0.5, iouThreshold: 0.2 });
    tr.update([det(0, box(0, 0))]);
    // Small move keeps the boxes overlapping so they associate and smooth.
    const t = tr.update([det(0, box(0.1, 0))]);
    // Halfway EMA of 0 -> 0.1 lands near 0.05, not the raw 0.1.
    expect(t[0].box.x).toBeGreaterThan(0.02);
    expect(t[0].box.x).toBeLessThan(0.08);
  });

  it('drops a track after maxMisses missed frames', () => {
    const tr = new DetectionTracker({ minHits: 1, maxMisses: 2 });
    tr.update([det(0, box(0.1, 0.1))]);
    expect(tr.update([]).length).toBe(0); // miss 1 (not confirmed alive)
    tr.update([]); // miss 2
    tr.update([]); // miss 3 -> dropped
    expect(tr.all()).toHaveLength(0);
  });

  it('keeps distinct classes as separate tracks even when boxes overlap', () => {
    const tr = new DetectionTracker({ minHits: 1 });
    const out = tr.update([det(0, box(0.1, 0.1)), det(1, box(0.1, 0.1))]);
    expect(out).toHaveLength(2);
  });
});

describe('ClassificationVoter', () => {
  it('returns the majority label with a confidence', () => {
    const v = new ClassificationVoter(5);
    v.push(2, 'cap-left', 0.9);
    v.push(2, 'cap-left', 0.8);
    v.push(3, 'cap-right', 0.7);
    v.push(2, 'cap-left', 0.85);
    const r = v.vote();
    expect(r?.classId).toBe(2);
    expect(r?.confidence).toBeGreaterThan(0);
  });

  it('refuses to commit when the window is split below the threshold', () => {
    const v = new ClassificationVoter(4);
    v.push(0, 'a', 0.6);
    v.push(1, 'b', 0.6);
    expect(v.vote(0.6)).toBeUndefined();
  });
});
