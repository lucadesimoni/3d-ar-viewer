import { describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';
import { activateOnKey } from './keys';

const key = (k: string) => ({ key: k, preventDefault: vi.fn() }) as unknown as KeyboardEvent;

describe('a row that acts like a button', () => {
  it.each(['Enter', ' '])('activates on %j, without the page scrolling', (k) => {
    const act = vi.fn();
    const e = key(k);
    activateOnKey(e, act);
    expect(act).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalled();
  });
  it('ignores other keys, so Tab still moves on', () => {
    const act = vi.fn();
    const e = key('Tab');
    activateOnKey(e, act);
    expect(act).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
