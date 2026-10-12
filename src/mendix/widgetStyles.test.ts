import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ensureWidgetStyles, scopeForWidget, WIDGET_ROOT_CLASS } from './widgetStyles';

const sample = `
:root { --accent: #22d3ee; }
html, body, #root { height: 100%; }
body { margin: 0; color: white; }
button { padding: 8px; }
@media (max-width: 600px) { button { padding: 4px; } }
@keyframes pulse { 0% { opacity: 1; } 100% { opacity: 0.4; } }
/* a comment with { braces } in it */
.app { display: flex; }
`;

describe('the stylesheet, for a page the app does not own', () => {
  const scoped = scopeForWidget(sample);

  it('puts every rule inside the widget\'s own scope', () => {
    expect(scoped).toContain(`@scope (.${WIDGET_ROOT_CLASS}) {`);
    const inside = scoped.slice(scoped.indexOf('@scope'));
    expect(inside).toContain('button { padding: 8px; }');
    expect(inside).toContain('@media (max-width: 600px)');
  });

  it('moves the page-level rules onto the widget root', () => {
    expect(scoped).not.toMatch(/:root\s*\{/);
    expect(scoped).not.toMatch(/(^|[\s,}])(html|body)\s*[,{]/);
    expect(scoped.match(/:scope \{/g)).toHaveLength(3);
  });

  it('keeps keyframes at the top level, where they still apply', () => {
    expect(scoped.indexOf('@keyframes pulse')).toBeLessThan(scoped.indexOf('@scope'));
  });

  it('handles the app\'s real stylesheet: nothing left outside the scope but keyframes', () => {
    const real = readFileSync('src/styles/app.css', 'utf8');
    const out = scopeForWidget(real);
    const outside = out.slice(0, out.indexOf('@scope'));
    expect(outside.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '').trim()).toBe('');
    // Braces still balance, so the browser reads the whole block.
    expect((out.match(/\{/g) ?? []).length).toBe((out.match(/\}/g) ?? []).length);
  });

  it('is put on the page once, however many widgets there are', () => {
    ensureWidgetStyles(sample);
    ensureWidgetStyles(sample);
    expect(document.querySelectorAll('#spatial-ar-widget-styles')).toHaveLength(1);
  });
});
