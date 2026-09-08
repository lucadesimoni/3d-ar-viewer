import { describe, expect, it, vi } from 'vitest';
import { awaitInSession, type StateSource } from './xr';

const IN_XR = 2;
const NOT_IN_XR = 3;
const ENTERING = 0;

/** A stand-in for Babylon's experience helper, driven by hand. */
function fakeSource(initial: number) {
  const listeners = new Set<(state: number) => void>();
  const source: StateSource & { emit(state: number): void } = {
    state: initial,
    onStateChangedObservable: {
      add(cb) { listeners.add(cb); return cb; },
      remove(observer) { listeners.delete(observer as (s: number) => void); return true; },
    },
    emit(state) { source.state = state; for (const cb of [...listeners]) cb(state); },
  };
  return { source, listeners };
}

/**
 * The trap this exists for.
 *
 * `enterXRAsync` resolves *before* the session is in XR — Babylon sets that
 * state from a one-shot first-frame observer, after the promise has returned.
 * Reading the state immediately therefore always sees ENTERING_XR. Treating
 * that as failure meant the app requested a session, was granted one, and then
 * tore it down a fraction of a second later, every single time. The symptom
 * reaching the operator was "AR is not supported on this device".
 */
describe('waiting for the XR session to really start', () => {
  it('does not give up while the session is still entering', async () => {
    const { source } = fakeSource(ENTERING);
    const pending = awaitInSession(source, IN_XR, NOT_IN_XR, 1000);
    // The first frame arrives a moment later, as it does on a phone.
    setTimeout(() => source.emit(IN_XR), 20);
    await expect(pending).resolves.toBe(true);
  });

  it('resolves at once when the session is already running', async () => {
    const { source } = fakeSource(IN_XR);
    await expect(awaitInSession(source, IN_XR, NOT_IN_XR, 1000)).resolves.toBe(true);
  });

  it('reports a genuine refusal rather than waiting for the timeout', async () => {
    const { source } = fakeSource(ENTERING);
    const pending = awaitInSession(source, IN_XR, NOT_IN_XR, 10_000);
    setTimeout(() => source.emit(NOT_IN_XR), 20);
    await expect(pending).resolves.toBe(false);
  });

  it('gives up if no frame ever arrives, and stops listening', async () => {
    vi.useFakeTimers();
    const { source, listeners } = fakeSource(ENTERING);
    const pending = awaitInSession(source, IN_XR, NOT_IN_XR, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBe(false);
    expect(listeners.size, 'a timed-out wait must not leak its observer').toBe(0);
    vi.useRealTimers();
  });
});
