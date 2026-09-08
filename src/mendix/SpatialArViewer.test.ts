import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpatialArViewer } from './SpatialArViewer';
import { useStore } from '../state/store';
import { gearbox } from '../data';

const appProps = vi.hoisted(() => vi.fn());
vi.mock('../App', () => ({ App: (props: unknown) => { appProps(props); return null; } }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useStore.setState(useStore.getInitialState(), true);
  appProps.mockClear();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('Mendix assembly boundary', () => {
  it('shows import failures without discarding the working assembly', async () => {
    const original = useStore.getState().assembly;
    await act(async () => {
      root.render(createElement(SpatialArViewer, { assemblyJson: { value: '{"parts":[]}' } }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('assembly.id');
    expect(useStore.getState().assembly).toBe(original);
  });

  it('loads valid new revisions and clears an earlier import error', async () => {
    await act(async () => {
      root.render(createElement(SpatialArViewer, { assemblyJson: { value: '{' } }));
    });
    await act(async () => {
      root.render(createElement(SpatialArViewer, {
        assemblyJson: { value: JSON.stringify({ ...gearbox, revision: 'B' }) },
      }));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(useStore.getState().assembly.revision).toBe('B');
  });

  it('fires completion only on an incomplete-to-complete transition', async () => {
    const execute = vi.fn();
    await act(async () => root.render(createElement(SpatialArViewer, { onComplete: { execute } })));
    await act(async () => {
      useStore.setState({ completedStepIds: new Set(gearbox.steps.map((s) => s.id)) });
      useStore.getState().selectPart(gearbox.parts[0].id);
      useStore.getState().setAnchor({ position: [0, 0, 1], rotation: [0, 0, 0, 1] }, 0.9);
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await act(async () => {
      useStore.setState({ completedStepIds: new Set() });
      useStore.setState({ completedStepIds: new Set(gearbox.steps.map((s) => s.id)) });
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('never treats a geometry-only export as completed work instructions', async () => {
    const execute = vi.fn();
    await act(async () => root.render(createElement(SpatialArViewer, {
      onComplete: { execute },
      assemblyJson: { value: JSON.stringify({ ...gearbox, steps: [] }) },
    })));
    await act(async () => useStore.getState().selectPart(gearbox.parts[0].id));
    expect(execute).not.toHaveBeenCalled();
  });

  it('forwards model URLs, ordered classes, and ambiguous occurrence mappings', async () => {
    await act(async () => root.render(createElement(SpatialArViewer, {
      detectorModelUrl: { value: '/models/catalogue.onnx' },
      detectorLabelsJson: { value: '["bolt","plate"]' },
      labelMappingJson: { value: '{"bolt":["occ-1","occ-2"],"plate":"occ-3"}' },
    })));
    expect(appProps).toHaveBeenLastCalledWith(expect.objectContaining({
      recognitionConfig: expect.objectContaining({
        detector: expect.objectContaining({ url: '/models/catalogue.onnx', labels: ['bolt', 'plate'] }),
        labelMapping: { bolt: ['occ-1', 'occ-2'], plate: 'occ-3' },
      }),
    }));
  });

  it('disables inference and explains missing host labels instead of guessing COCO classes', async () => {
    await act(async () => root.render(createElement(SpatialArViewer, {
      detectorModelUrl: { value: '/models/catalogue.onnx' },
    })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('detectorLabelsJson');
    expect(appProps).toHaveBeenLastCalledWith(expect.objectContaining({ recognitionConfig: {} }));
  });
});
