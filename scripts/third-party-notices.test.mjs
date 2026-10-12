// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { allowsProprietary, licenceOf, noticeFor, renderNotices } from './third-party-notices.mjs';

describe('third-party notices', () => {
  it('lets through only licences that allow a proprietary product', () => {
    for (const ok of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', '(MIT OR GPL-3.0)', 'MIT AND Apache-2.0']) {
      expect(allowsProprietary(ok), ok).toBe(true);
    }
    for (const no of ['GPL-3.0-only', 'AGPL-3.0', 'LGPL-2.1', 'SSPL-1.0', 'UNKNOWN', 'MIT AND GPL-2.0', 'SEE LICENSE IN LICENSE']) {
      expect(allowsProprietary(no), no).toBe(false);
    }
  });

  it('reads the licence however a package states it', () => {
    expect(licenceOf({ license: 'MIT' })).toBe('MIT');
    expect(licenceOf({ license: { type: 'ISC' } })).toBe('ISC');
    expect(licenceOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0');
    expect(licenceOf({})).toBe('UNKNOWN');
  });

  it('carries a package\'s own licence text, and the standard text with its holder when it ships none', () => {
    const react = noticeFor('node_modules/react');
    expect(react.licence).toBe('MIT');
    expect(react.text).toMatch(/Copyright \(c\) Meta Platforms/);
    const ort = noticeFor('node_modules/onnxruntime-web');
    expect(ort.text).toMatch(/Copyright \(c\) Microsoft Corporation/);
    expect(ort.text).toMatch(/Permission is hereby granted/);
  });

  it('names every component with its version and licence', () => {
    const out = renderNotices([{ name: 'a', version: '1.0.0', licence: 'MIT', text: 'text a' }]);
    expect(out).toContain('a 1.0.0 — MIT');
    expect(out).toContain('text a');
  });
});
