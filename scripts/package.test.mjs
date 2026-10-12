// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assetNames, installNotes, packageXmlFor, releaseNotes, stagedPackageJson } from './package.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('release packaging', () => {
  it('names every asset after the version', () => {
    const n = assetNames('1.2.3', 'someone');
    expect(Object.values(n).filter((f) => f.includes('1.2.3'))).toHaveLength(4);
    expect(n.npm).toBe('someone-spatial-ar-viewer-1.2.3.tgz');   // what `npm pack` names a scoped package
  });

  it('ships the server package with no dependencies, scoped for GitHub Packages', () => {
    const m = stagedPackageJson(pkg, 'someone');
    expect(m.name).toBe('@someone/spatial-ar-viewer');
    expect(m.version).toBe(pkg.version);
    expect(m.dependencies).toBeUndefined();
    expect(m.devDependencies).toBeUndefined();
    expect(m.scripts).toBeUndefined();
    expect(m.bin['spatial-ar-viewer']).toBe('server/serve.mjs');
    expect(m.publishConfig.registry).toBe('https://npm.pkg.github.com');
  });

  it('puts the release version into the widget\'s package.xml', () => {
    const template = readFileSync('src/mendix/package.xml', 'utf8');
    const out = packageXmlFor(template, '1.2.3');
    expect(out).toMatch(/<clientModule name="SpatialArViewer" version="1\.2\.3"/);
    expect(out).toContain('<file path="anthropic/spatialarviewer"/>');
  });

  it('refuses a version Mendix cannot take', () => {
    expect(() => packageXmlFor('<clientModule version="0.0.0">', '1.2.3-rc.1')).toThrow(/x\.y\.z/);
  });

  it('cuts this version\'s notes out of the changelog', () => {
    const log = '# Changelog\n\n## [1.1.0] — later\n\nNewer.\n\n## [1.0.0] — first\n\n- One.\n- Two.\n';
    expect(releaseNotes(log, '1.0.0')).toBe('- One.\n- Two.\n');
    expect(releaseNotes(log, '1.1.0')).toBe('Newer.\n');
  });

  it('refuses to release a version the changelog says nothing about', () => {
    expect(() => releaseNotes('# Changelog\n\n## [1.0.0]\n\n- One.\n', '2.0.0')).toThrow(/no section for 2\.0\.0/);
    expect(() => releaseNotes('# Changelog\n\n## [2.0.0]\n\n## [1.0.0]\n- x\n', '2.0.0')).toThrow(/empty/);
  });

  it('tells each component\'s user how to get it, by this version\'s names', () => {
    const notes = installNotes('1.2.3', 'someone');
    for (const name of Object.values(assetNames('1.2.3', 'someone')).filter((f) => !f.endsWith('.md'))) {
      expect(notes).toContain(name);
    }
    expect(notes).toContain('ghcr.io/someone/3d-ar-viewer:1.2.3');
    expect(notes).toContain('@someone/spatial-ar-viewer@1.2.3');
  });

  it('has notes for the version in package.json', () => {
    // Any notes will do: an automatic release's are one line per merge, and
    // the first one of those was 44 characters. (This asked for more than
    // 100, and stopped that release.) Missing or empty notes throw.
    expect(releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), pkg.version)).toMatch(/\S/);
  });
});
