import { describe, expect, it } from 'vitest';
import { safeColor } from './safeColor';

describe('an accent colour from a link', () => {
  it.each(['#ff7a00', '#f70', 'rgb(255, 122, 0)', 'hsl(28 100% 50%)', 'orange'])('accepts %s', (c) => {
    expect(safeColor(c)).toBe(c);
  });

  it.each([
    'url(https://tracker.example/x)',
    'red; background: url(x)',
    'var(--secret)',
    'linear-gradient(red, blue)',
    'expression(alert(1))',
    '"><script>',
    '',
  ])('refuses %s', (c) => {
    expect(safeColor(c)).toBeUndefined();
  });
});
