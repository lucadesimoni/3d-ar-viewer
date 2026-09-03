import { describe, expect, it } from 'vitest';
import { connectorLocalFrame } from './math';
import type { Connector } from './types';

describe('connectorLocalFrame memoization', () => {
  it('returns the same cached frame object for repeated calls', () => {
    const c: Connector = { id: 'k', kind: 'pin', position: [0, 0, 0.05], axis: [0, 0, 1], up: [0, 1, 0], accepts: ['socket'] };
    const a = connectorLocalFrame(c);
    const b = connectorLocalFrame(c);
    expect(a).toBe(b); // identity => cache hit
    expect(a.position).toEqual([0, 0, 0.05]);
  });
});
