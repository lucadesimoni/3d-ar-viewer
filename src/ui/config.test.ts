import { describe, expect, it } from 'vitest';
import { resolveUiConfig, parseUiConfigFromParams } from './config';

describe('resolveUiConfig', () => {
  it('defaults to the full preset with everything on', () => {
    const c = resolveUiConfig();
    expect(c.preset).toBe('full');
    expect(c.showHeader && c.showSteps && c.showDiagnostics && c.showModeBar).toBe(true);
  });

  it('minimal preset shows the guide but hides side panels and mode bar', () => {
    const c = resolveUiConfig({ preset: 'minimal' });
    expect(c.showSteps).toBe(true);
    expect(c.showDiagnostics).toBe(false);
    expect(c.showModeBar).toBe(false);
    expect(c.showHeader).toBe(false);
    expect(c.showRecognition).toBe(true);
  });

  it('viewer preset is bare — only the canvas + on-part recognition', () => {
    const c = resolveUiConfig({ preset: 'viewer' });
    expect(c.showSteps).toBe(false);
    expect(c.showHeader).toBe(false);
    expect(c.showRecognition).toBe(true);
    expect(c.showRecognitionBanner).toBe(false);
  });

  it('explicit overrides win over the preset', () => {
    const c = resolveUiConfig({ preset: 'minimal', showDiagnostics: true });
    expect(c.showDiagnostics).toBe(true);
    expect(c.showModeBar).toBe(false); // untouched preset default
  });
});

describe('parseUiConfigFromParams', () => {
  it('reads preset, embedded and accent', () => {
    const c = parseUiConfigFromParams('?ui=minimal&embedded=1&accent=%23ff7a00');
    expect(c.preset).toBe('minimal');
    expect(c.embedded).toBe(true);
    expect(c.accent).toBe('#ff7a00');
  });

  it('reads panel toggles with 0/1/true/false', () => {
    const c = parseUiConfigFromParams('?diagnostics=0&steps=true&modebar=off');
    expect(c.showDiagnostics).toBe(false);
    expect(c.showSteps).toBe(true);
    expect(c.showModeBar).toBe(false);
  });

  it('panels= turns exactly the listed panels on and the rest off', () => {
    const c = parseUiConfigFromParams('?panels=steps,diagnostics');
    expect(c.showSteps).toBe(true);
    expect(c.showDiagnostics).toBe(true);
    expect(c.showModeBar).toBe(false);
    expect(c.showInspector).toBe(false);
  });

  it('ignores unknown/empty params', () => {
    expect(parseUiConfigFromParams('')).toEqual({});
    expect(parseUiConfigFromParams('?foo=bar')).toEqual({});
  });

  it('round-trips through resolve for an embed URL', () => {
    const c = resolveUiConfig(parseUiConfigFromParams('?ui=viewer&recognition=1'));
    expect(c.preset).toBe('viewer');
    expect(c.showRecognition).toBe(true);
    expect(c.showSteps).toBe(false);
  });
});
