/// <reference types="node" />
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const code = readFileSync(resolve('public', 'sw.js'), 'utf8');

function worker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const cache = { match: vi.fn(), put: vi.fn() };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ['spatial-ar-v2', 'spatial-ar-v3', 'host-application-v1']),
    delete: vi.fn(async () => true),
  };
  const fetch = vi.fn(async () => new Response('bundle', { status: 200 }));
  runInNewContext(code, {
    URL, Response, fetch, caches, setTimeout, clearTimeout,
    self: {
      location: { origin: 'https://viewer.example' },
      addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
      clients: { claim: vi.fn() }, skipWaiting: vi.fn(),
    },
  });
  const request = (path: string, init?: RequestInit) => {
    const respondWith = vi.fn<(response: Promise<Response>) => void>();
    listeners.get('fetch')!({
      request: new Request(`https://viewer.example${path}`, init), respondWith,
    });
    return respondWith;
  };
  return { listeners, cache, caches, fetch, request };
}

describe('embedded viewer offline cache', () => {
  it.each(['/cad/part.glb', '/assets/part.glb', '/models/detector.onnx', '/api/teamcenter/bom'])(
    'does not intercept private assembly resources: %s', (url) => {
      const w = worker();
      expect(w.request(url)).not.toHaveBeenCalled();
      expect(w.fetch).not.toHaveBeenCalled();
    },
  );

  it('caches runtime bundles but respects no-store and authorization requests', async () => {
    const w = worker();
    const response = w.request('/assets/app-abc123.js');
    expect(response).toHaveBeenCalledOnce();
    expect((await response.mock.calls[0][0]).status).toBe(200);
    expect(w.cache.put).toHaveBeenCalledOnce();
    expect(w.request('/assets/app.js', { cache: 'no-store' })).not.toHaveBeenCalled();
    expect(w.request('/assets/app.js', { headers: { Authorization: 'Bearer example' } })).not.toHaveBeenCalled();
  });

  it.each(['no-store', 'private, max-age=0'])('does not persist a %s response', async (cacheControl) => {
    const w = worker();
    w.fetch.mockResolvedValue(new Response('private', { headers: { 'Cache-Control': cacheControl } }));
    const response = w.request('/assets/app-abc123.js');
    await response.mock.calls[0][0];
    expect(w.cache.put).not.toHaveBeenCalled();
  });

  it('leaves the embedding host caches untouched on activation', async () => {
    const w = worker();
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    w.listeners.get('activate')!({ waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(w.caches.delete).toHaveBeenCalledExactlyOnceWith('spatial-ar-v2');
  });
});
