import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlacementHint } from './PlacementHint';
import { useStore } from '../state/store';
import { kallax4x2Assembly } from '../data/kallax';
import type { XrCameraImage } from './xrCameraWatch';

let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  const s = useStore.getState();
  s.loadAssembly(kallax4x2Assembly);
  s.setArSource('webxr');
  s.setArPlacement('awaiting');
  s.setArTracking({ ready: true, reason: 'settled', goodFrames: 60, emulated: false, hasHit: true, waitedMs: 1200 });
});
afterEach(() => vi.unstubAllGlobals());

async function hint(image: XrCameraImage | undefined): Promise<string> {
  useStore.getState().setXrCameraImage(image);
  const root = createRoot(host);
  await act(async () => root.render(createElement(PlacementHint)));
  const text = host.textContent ?? '';
  await act(async () => root.unmount());
  return text;
}

describe('the placement hint in a WebXR session with a recognition target', () => {
  it('invites recognition while the camera image is still expected', async () => {
    expect(await hint('unknown')).toMatch(/Point it at the/);
  });

  it('and once the host has handed over a frame', async () => {
    expect(await hint('available')).toMatch(/Point it at the/);
  });

  it('does not promise recognition when the host gives no camera image', async () => {
    const text = await hint('unavailable');
    expect(text).not.toMatch(/Point it at the/);
    expect(text).toMatch(/no camera image/);
    expect(text).toMatch(/tap to place/);
  });
});
