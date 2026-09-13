import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { SceneManager } from './SceneManager';
import { isUniform } from './cameraFrame';
import { gearbox } from '../../data';
import type { XrHooks } from './xr';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('./xr', () => ({ prepareImmersiveAr: prepare }));

const W = 8;
const H = 8;

/**
 * A camera texture that only has pixels while the frame is open — which is
 * what the real one does, and what nothing here knew until a device sent back
 * 886x1920 zeroes with no error attached.
 */
function frameScopedTexture() {
  const state = { open: false, reads: 0 };
  const texture = {
    getSize: () => ({ width: W, height: H }),
    getInternalTexture: () => ({ invertY: false }),
    readPixels: (_f: number, _l: number, buffer: Uint8Array) => {
      state.reads++;
      // Inside the frame, a picture. Outside it the UA has invalidated the
      // texture and the read still "works" — returning nothing at all.
      for (let i = 0; i < W * H * 4; i++) buffer[i] = state.open ? (i * 29) & 255 : 0;
      return Promise.resolve(buffer);
    },
  } as unknown as BaseTexture;
  return { texture, state };
}

async function inSession() {
  const hooks: XrHooks[] = [];
  prepare.mockImplementation(async (_s: unknown, _o: unknown, callbacks: XrHooks) => {
    hooks.push(callbacks);
    return { enter: async () => ({ end: vi.fn(async () => {}) }), dispose: vi.fn() };
  });
  const manager = new SceneManager(document.createElement('canvas'), gearbox, {}, {
    engine: new NullEngine(), kind: 'webgl',
    perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
  });
  await manager.prepareWebXr({ onPlace: vi.fn(), onEnd: vi.fn() });
  await manager.startWebXr(vi.fn(), vi.fn());
  const hook = hooks[hooks.length - 1];
  hook.onStateChange?.(true);
  return { manager, hook };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the camera frame is taken inside the frame that owns it', () => {
  it('waits for an XR frame instead of reading whenever it is asked', async () => {
    // The bug this exists to prevent, in full. The `WebGLTexture` behind an XR
    // camera image is valid only inside the XR animation frame it came from.
    // Reading it from the page's own rAF — which is not the session's — took a
    // real 10.6 ms on a device and returned 886x1920 pixels of zero, then
    // attached them to a diagnostics file as a successful capture.
    const { manager, hook } = await inSession();
    const { texture, state } = frameScopedTexture();
    try {
      hook.onCameraFrame?.(texture);          // a frame goes by; nobody asked
      expect(state.reads).toBe(0);

      let served: ImageData | undefined;
      let settled = false;
      const wanted = manager.xrCameraFrame(W)
        .then((image) => { served = image; settled = true; });
      await Promise.resolve();
      // Nothing yet: the request is waiting for a frame to serve it.
      expect(state.reads).toBe(0);
      expect(settled).toBe(false);

      state.open = true;
      hook.onCameraFrame?.(texture);
      await wanted;
      expect(state.reads).toBe(1);
      expect(settled).toBe(true);
      expect(served?.width).toBe(W);
      expect(isUniform(served!)).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it('refuses a frame with nothing in it rather than passing it off as a picture', async () => {
    const { manager, hook } = await inSession();
    const { texture, state } = frameScopedTexture();
    try {
      hook.onCameraFrame?.(texture);          // the session has a camera
      state.open = false;                     // but the texture is invalidated
      const wanted = manager.xrCameraFrame(W);
      hook.onCameraFrame?.(texture);
      expect(await wanted).toBeUndefined();
      // And it says so, rather than leaving the failure to be guessed at.
      expect(manager.cameraFrameCost()?.uniform).toBe(true);
      expect(manager.renderStats().frameUniform).toBe(true);
    } finally {
      manager.dispose();
    }
  });

  it('does not leave a caller waiting on a session that has stopped', async () => {
    const { manager, hook } = await inSession();
    const { texture } = frameScopedTexture();
    try {
      hook.onCameraFrame?.(texture);
      const wanted = manager.xrCameraFrame(W);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await wanted).toBeUndefined();

      // And a session that ends with someone waiting answers them at once.
      hook.onCameraFrame?.(texture);
      const second = manager.xrCameraFrame(W);
      hook.onCameraFrame?.(undefined);
      expect(await second).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it('serves two askers from one readback', async () => {
    const { manager, hook } = await inSession();
    const { texture, state } = frameScopedTexture();
    try {
      state.open = true;
      hook.onCameraFrame?.(texture);
      const a = manager.xrCameraFrame(W);
      const b = manager.xrCameraFrame(W);
      hook.onCameraFrame?.(texture);
      expect(await a).toBeDefined();
      expect(await b).toBeDefined();
      expect(state.reads).toBe(1);
    } finally {
      manager.dispose();
    }
  });
});

describe('telling a picture from a blank rectangle', () => {
  const filled = (value: number, poke?: number): ImageData => {
    const d = new Uint8ClampedArray(4 * 40 * 40).fill(value);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    if (poke !== undefined) d[poke * 4] = value === 0 ? 90 : 0;
    return new ImageData(d, 40, 40);
  };

  it('calls an all-one-colour frame what it is', () => {
    expect(isUniform(filled(0))).toBe(true);
    expect(isUniform(filled(255))).toBe(true);
  });

  it('and never calls a real one that', () => {
    // One pixel different anywhere the sampling reaches is a picture.
    expect(isUniform(filled(0, 1))).toBe(false);
    const noisy = new Uint8ClampedArray(4 * 40 * 40);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 31) & 255;
    expect(isUniform(new ImageData(noisy, 40, 40))).toBe(false);
  });
});
