import { describe, expect, it } from 'vitest';
import { appClipBase, appClipHref } from './AppClipLink';

/**
 * The iOS route to positional tracking.
 *
 * iOS Safari has no WebXR and is not going to get it, so the only way an
 * iPhone runs this app with real ARKit tracking is an App Clip that provides
 * the WebXR API to an ordinary page. That is a link, and a link that is subtly
 * wrong — a URL pasted in unencoded, a query string that swallows the rest —
 * fails in a way nobody can debug from a phone.
 */
describe('the iOS App Clip link', () => {
  it('encodes the target so its own query survives', () => {
    const href = appClipHref('https://clip.example/ar', 'https://app.example/?assembly=kallax-4x4&x=1');
    expect(href).toBe(
      'https://clip.example/ar?url=https%3A%2F%2Fapp.example%2F%3Fassembly%3Dkallax-4x4%26x%3D1',
    );
    // Round-trips: the clip has to be able to read back exactly what we meant.
    const back = new URL(href).searchParams.get('url');
    expect(new URL(back!).searchParams.get('assembly')).toBe('kallax-4x4');
  });

  it('can be pointed elsewhere, or turned off', () => {
    expect(appClipBase('')).toContain('https://');
    expect(appClipBase('?appclip=https://our-own/clip')).toBe('https://our-own/clip');
    // Sending operators to a third party is a deployment's decision to refuse.
    expect(appClipBase('?appclip=off')).toBeUndefined();
  });
});
