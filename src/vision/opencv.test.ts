import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * OpenCV.js as it really arrives: an Emscripten module whose object has its
 * own `then`, calling back with the module itself once the runtime is up.
 */
function emscriptenModule(initialised: boolean) {
  const mod: Record<string, unknown> = {};
  const callbacks: Array<(m: unknown) => void> = [];
  mod.then = (f: (m: unknown) => void) => {
    if ('Mat' in mod) f(mod);
    else callbacks.push(f);
    return mod;
  };
  const initialise = () => {
    mod.Mat = class {};
    for (const f of callbacks.splice(0)) f(mod);
  };
  if (initialised) initialise();
  return { mod, initialise };
}

/** Load `loadOpenCV` fresh, with the script "arriving" as `cv`. */
async function loadWith(cv: unknown) {
  vi.resetModules();
  const { loadOpenCV } = await import('./opencv');
  vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
    (window as unknown as { cv?: unknown }).cv = cv;
    queueMicrotask(() => (node as HTMLScriptElement).onload?.(new Event('load')));
    return node;
  });
  return loadOpenCV('/assets/opencv.js');
}

const settles = <T,>(p: Promise<T>, ms = 1000) =>
  Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { cv?: unknown }).cv;
});

describe('loading OpenCV.js', () => {
  it('settles with the module, though the module is itself thenable', async () => {
    // Resolving a promise with the module adopts its `then`, which hands the
    // module back, which is adopted again: the page froze for good.
    const { mod } = emscriptenModule(true);
    const cv = await settles(loadWith(mod));
    expect(cv).toBe(mod);
    expect('Mat' in (cv as object)).toBe(true);
  });

  it('waits for a runtime that is not initialised yet', async () => {
    const { mod, initialise } = emscriptenModule(false);
    const loading = loadWith(mod);
    setTimeout(initialise, 20);
    const cv = await settles(loading);
    expect(cv).toBe(mod);
    expect('Mat' in (cv as object)).toBe(true);
  });
});
