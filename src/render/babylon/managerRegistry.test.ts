import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveManager, setActiveManager, withActiveManager } from './managerRegistry';
import type { SceneManager } from './SceneManager';

const fake = (name: string) => ({ name }) as unknown as SceneManager;

afterEach(() => setActiveManager(undefined));

describe('the active manager registry', () => {
  it('runs a waiting callback once the manager arrives — the renderer loads on demand', () => {
    const cb = vi.fn();
    withActiveManager(cb);
    expect(cb).not.toHaveBeenCalled();
    const m = fake('a');
    setActiveManager(m);
    expect(cb).toHaveBeenCalledWith(m);
    setActiveManager(fake('b'));
    expect(cb, 'once, not on every later manager').toHaveBeenCalledTimes(1);
  });

  it('runs straight away when a manager already exists', () => {
    const m = fake('a');
    setActiveManager(m);
    const cb = vi.fn();
    withActiveManager(cb);
    expect(cb).toHaveBeenCalledWith(m);
    expect(getActiveManager()).toBe(m);
  });

  it('can be cancelled before the manager arrives', () => {
    const cb = vi.fn();
    const cancel = withActiveManager(cb);
    cancel();
    setActiveManager(fake('a'));
    expect(cb).not.toHaveBeenCalled();
  });
});
