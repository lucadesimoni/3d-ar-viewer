import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installEmbedBridge, parseParentOrigin, EMBED_CHANNEL } from './bridge';
import { useStore } from '../state/store';
import { gearbox } from '../data';

const origin = 'https://plm.example.com';
let dispose: () => void;
let post: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true);
  post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  dispose = installEmbedBridge(origin);
  post.mockClear();
});
afterEach(() => { dispose(); vi.restoreAllMocks(); });

function send(payload: Record<string, unknown>, from = origin, source: MessageEventSource | null = window.parent) {
  window.dispatchEvent(new MessageEvent('message', {
    source, origin: from,
    data: { channel: EMBED_CHANNEL, version: 1, requestId: 'request-1', ...payload },
  }));
}

describe('iframe host contract', () => {
  it('accepts only the configured parent window and exact origin', () => {
    send({ type: 'select-part', partId: gearbox.parts[0].id }, 'https://attacker.example');
    send({ type: 'select-part', partId: gearbox.parts[0].id }, origin, null);
    expect(useStore.getState().selectedPartId).toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });

  it('reports a versioned state response only to the pinned origin', () => {
    send({ type: 'get-state' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      channel: EMBED_CHANNEL, version: 1, requestId: 'request-1', ok: true,
      state: expect.objectContaining({ assembly: expect.objectContaining({ id: gearbox.id }) }),
    }), origin);
  });

  it('rejects invalid assemblies without replacing the current state', () => {
    const original = useStore.getState().assembly;
    send({ type: 'load-assembly', assembly: { id: 'broken', parts: [] } });
    expect(useStore.getState().assembly).toBe(original);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: 'invalid-assembly' }),
    }), origin);
  });

  it('loads a new revision of the same assembly id atomically', () => {
    send({ type: 'load-assembly', assembly: { ...gearbox, revision: 'next' } });
    expect(useStore.getState().assembly.revision).toBe('next');
    expect(useStore.getState().assembly.id).toBe(gearbox.id);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), origin);
  });

  it('selects an occurrence, clears selection, and changes active step', () => {
    send({ type: 'select-part', partId: gearbox.parts[0].id });
    expect(useStore.getState().selectedPartId).toBe(gearbox.parts[0].id);
    send({ type: 'select-part', partId: null });
    expect(useStore.getState().selectedPartId).toBeUndefined();
    send({ type: 'set-step', stepId: gearbox.steps[1].id });
    expect(useStore.getState().activeStepId).toBe(gearbox.steps[1].id);
  });

  it.each([
    { type: 'select-part', partId: 'not-in-bom' },
    { type: 'set-step', stepId: 'not-in-plan' },
    { type: 'get-state', version: 2 },
    { type: 'get-state', requestId: '' },
    { type: 'sign-off-everything' },
  ])('rejects malformed or unsupported commands: %j', (command) => {
    send(command);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ok: false }), origin);
  });

  it('requires leaving AR before a host replaces the workpiece', () => {
    useStore.getState().setArSource('webxr');
    send({ type: 'load-assembly', assembly: gearbox });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: 'ar-active' }),
    }), origin);
  });

  it('removes the listener on disposal', () => {
    dispose();
    send({ type: 'get-state' });
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['*', 'null', 'file:///host', 'https://plm.example.com/path', 'https://plm.example.com/'])(
    'rejects a non-origin allowlist value %s', (value) => {
      expect(() => parseParentOrigin(value)).toThrow();
    },
  );
});
