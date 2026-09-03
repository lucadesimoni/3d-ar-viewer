import { describe, expect, it } from 'vitest';
import { softNonMaxSuppression, nonMaxSuppression, type Detection } from './onnx';

const d = (classId: number, x: number, score: number): Detection => ({
  label: `c${classId}`, classId, score, box: { x, y: 0, w: 0.3, h: 0.3 },
});

describe('softNonMaxSuppression', () => {
  it('recovers a real overlapping same-class box that hard NMS would delete', () => {
    const dets = [d(0, 0, 0.9), d(0, 0.05, 0.8)]; // heavy overlap, both real
    expect(nonMaxSuppression(dets, 0.4)).toHaveLength(1);   // hard: drops the 2nd
    const soft = softNonMaxSuppression(dets, 0.4, 0.2);      // soft: decays but keeps
    expect(soft.length).toBe(2);
    expect(soft[1].score).toBeLessThan(0.8);                 // decayed
  });

  it('keeps non-overlapping boxes untouched', () => {
    const dets = [d(0, 0, 0.9), d(0, 0.8, 0.85)];
    const soft = softNonMaxSuppression(dets, 0.4, 0.2);
    expect(soft).toHaveLength(2);
    expect(soft.find((x) => x.box.x === 0.8)!.score).toBeCloseTo(0.85, 5);
  });
});
