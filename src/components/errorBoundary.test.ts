import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { logEntries } from '../diagnostics/log';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Boom(): null {
  throw new Error('render exploded');
}

describe('a component that throws while rendering', () => {
  it('leaves a message and a way back, not a blank page', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(createElement(ErrorBoundary, null, createElement(Boom))));
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Something went wrong/);
    expect(host.querySelector('button')?.textContent).toBe('Reload');
    await act(async () => root.unmount());
  });

  it('and the error reaches the diagnostics log', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(createElement(ErrorBoundary, null, createElement(Boom))));
    expect(logEntries().some((e) => e.kind === 'error' && e.message.includes('render exploded'))).toBe(true);
    await act(async () => root.unmount());
  });

  it('renders its children untouched when nothing throws', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(createElement(ErrorBoundary, null, createElement('p', null, 'fine'))));
    expect(host.textContent).toBe('fine');
    await act(async () => root.unmount());
  });
});
