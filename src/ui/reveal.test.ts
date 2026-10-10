import { describe, expect, it } from 'vitest';
import { revealOffset } from './reveal';

describe('revealOffset', () => {
  it('leaves an item that is already in view where it is', () => {
    expect(revealOffset(0, 330, 120, 34)).toBeUndefined();
    expect(revealOffset(200, 330, 300, 34)).toBeUndefined();
  });

  it('centres an item past the far edge', () => {
    // Step 12 of a phone strip: 34 px chips every 40 px, 330 px visible.
    expect(revealOffset(0, 330, 440, 34)).toBe(440 + 17 - 165);
  });

  it('centres an item before the near edge, never past the start', () => {
    expect(revealOffset(400, 330, 300, 34)).toBe(300 + 17 - 165);
    expect(revealOffset(400, 330, 0, 34)).toBe(0);
  });

  it('counts an item cut by the margin as out of view', () => {
    expect(revealOffset(0, 330, 300, 34, 8)).toBe(300 + 17 - 165);
  });
});
