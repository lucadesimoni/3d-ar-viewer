import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneManager } from './useSceneManager';
import { useStore } from '../../state/store';
import { gearbox } from '../../data';

const createManager = vi.hoisted(() => vi.fn());
vi.mock('./SceneManager', () => ({ SceneManager: { create: createManager } }));
vi.mock('./managerRegistry', () => ({ setActiveManager: vi.fn() }));

let root: Root;
const manager = () => ({
  frameCamera: vi.fn(), loadAssembly: vi.fn(), tick: vi.fn(), update: vi.fn(),
  setAnchor: vi.fn(), setTransparent: vi.fn(), dispose: vi.fn(),
});

function Harness() {
  const ref = useRef<HTMLCanvasElement>(null);
  useSceneManager(ref);
  return createElement('canvas', { ref });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useStore.setState(useStore.getInitialState(), true);
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('external assembly scene refresh', () => {
  it('rebuilds geometry when a new revision reuses the same assembly id', async () => {
    const m = manager();
    createManager.mockResolvedValue(m);
    await act(async () => root.render(createElement(Harness)));
    expect(m.loadAssembly).not.toHaveBeenCalled();
    const revision = { ...gearbox, revision: 'B', name: 'Updated CAD assembly' };
    await act(async () => useStore.getState().loadAssembly(revision));
    expect(m.loadAssembly).toHaveBeenCalledExactlyOnceWith(revision);
  });

  it('loads the latest host manifest if it arrives during async renderer creation', async () => {
    const m = manager();
    let finish!: (value: typeof m) => void;
    createManager.mockReturnValue(new Promise<typeof m>((resolve) => { finish = resolve; }));
    await act(async () => root.render(createElement(Harness)));
    const revision = { ...gearbox, revision: 'C' };
    await act(async () => useStore.getState().loadAssembly(revision));
    await act(async () => finish(m));
    expect(m.loadAssembly).toHaveBeenCalledExactlyOnceWith(revision);
  });
});
