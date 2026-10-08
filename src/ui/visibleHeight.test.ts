import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackVisibleHeight } from './visibleHeight';

afterEach(() => vi.unstubAllGlobals());

function viewport(height: number, scale: number) {
  const listeners: Record<string, () => void> = {};
  const vv = {
    height, scale,
    addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('visualViewport', vv);
  return { vv, fire: (type: string) => listeners[type]?.() };
}

describe('the height the operator can see', () => {
  it('follows the visible area — a toolbar or keyboard takes from it', () => {
    const { vv, fire } = viewport(700, 1);
    const root = document.createElement('div');
    const stop = trackVisibleHeight(root);
    expect(root.style.getPropertyValue('--app-h')).toBe('700px');
    vv.height = 400;
    fire('resize');
    expect(root.style.getPropertyValue('--app-h')).toBe('400px');
    stop();
  });

  it('but a pinch-zoom does not squash the layout', () => {
    const { vv, fire } = viewport(700, 1);
    const root = document.createElement('div');
    const stop = trackVisibleHeight(root);
    vv.height = 350;
    vv.scale = 2;
    fire('resize');
    expect(root.style.getPropertyValue('--app-h')).toBe('700px');
    stop();
  });
});
