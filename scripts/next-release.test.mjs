// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bumpLevel, changelogSection, dropEmptyUnreleased, insertSection, nextVersion, releaseEntries, releaseUnreleased } from './next-release.mjs';
import { releaseNotes } from './package.mjs';

describe('the next release', () => {
  it('bumps the version', () => {
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(nextVersion('v0.1.9', 'minor')).toBe('0.2.0');
    expect(nextVersion('1.4.2', 'major')).toBe('2.0.0');
    expect(() => nextVersion('1.0.0-rc.1', 'patch')).toThrow(/x\.y\.z/);
  });

  it('is a patch unless a merge asks for more', () => {
    expect(bumpLevel(['Merge: fix a thing', 'Merge: another'])).toBe('patch');
    expect(bumpLevel(['Merge: a feature [minor]', 'Merge: fix'])).toBe('minor');
    expect(bumpLevel(['Merge: a feature [minor]', 'Merge: new API [major]'])).toBe('major');
    expect(bumpLevel(['Merge: x\n\nBREAKING CHANGE: the widget id'])).toBe('major');
    expect(bumpLevel(['Merge: fix'], 'minor'), 'never less than asked for').toBe('minor');
  });

  it('lists each merge once, without the release commits', () => {
    expect(releaseEntries([
      'Merge: bring in front onto the floor',
      'Release v0.1.1',
      'Merge: a feature [minor]',
      'Merge: bring in front onto the floor',
      '',
    ])).toEqual(['Bring in front onto the floor', 'A feature']);
  });

  it('writes the section above the newest version, where the release reads it back', () => {
    const log = '# Changelog\n\nPreamble.\n\n## [0.1.0] — first release\n\n- Old.\n';
    const out = insertSection(log, changelogSection('0.1.1', '2026-10-12', ['New thing', 'Fix']));
    expect(out.indexOf('## [0.1.1]')).toBeLessThan(out.indexOf('## [0.1.0]'));
    expect(out.indexOf('Preamble.')).toBeLessThan(out.indexOf('## [0.1.1]'));
    // The release workflow refuses a version without notes: these are found.
    expect(releaseNotes(out, '0.1.1')).toBe('- New thing\n- Fix\n');
    expect(releaseNotes(out, '0.1.0')).toBe('- Old.\n');
  });

  it('releases hand-written notes as written, in place of the list', () => {
    const log = '# Changelog\n\n## [Unreleased]\n\n### Highlights\n\n- The widget in Studio Pro.\n\n## [0.1.0] — first\n\n- Old.\n';
    const out = releaseUnreleased(log, '0.2.0', '2026-10-12');
    expect(out).toContain('## [0.2.0] — 2026-10-12');
    expect(out).not.toContain('Unreleased');
    expect(releaseNotes(out, '0.2.0')).toBe('### Highlights\n\n- The widget in Studio Pro.\n');
  });

  it('uses the list when the Unreleased section is empty, and drops its heading', () => {
    const log = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] — first\n\n- Old.\n';
    expect(releaseUnreleased(log, '0.1.1', '2026-10-12')).toBeUndefined();
    const out = insertSection(dropEmptyUnreleased(log), changelogSection('0.1.1', '2026-10-12', ['Fix']));
    expect(out).not.toContain('Unreleased');
    expect(releaseNotes(out, '0.1.1')).toBe('- Fix\n');
  });

  it('replaces the section of an attempt that never published, rather than repeating it', () => {
    // A release commit landed, its Release run failed, no tag: the retry
    // computes the same version and must not add a second section for it.
    const log = '# Changelog\n\n## [0.1.1] — 2026-10-12\n\n- First try.\n\n## [0.1.0] — first\n\n- Old.\n';
    const out = insertSection(log, changelogSection('0.1.1', '2026-10-13', ['First try.', 'The fix.']));
    expect(out.match(/## \[0\.1\.1\]/g)).toHaveLength(1);
    expect(releaseNotes(out, '0.1.1')).toBe('- First try.\n- The fix.\n');
    expect(releaseNotes(out, '0.1.0')).toBe('- Old.\n');
  });
});
