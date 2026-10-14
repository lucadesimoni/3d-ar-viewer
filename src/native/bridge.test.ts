import { afterEach, describe, expect, it } from 'vitest';
import { nativeBridge, nativeHostAvailable, parseNativeMessage, resetNativeBridge } from './bridge';

const pose = { position: [0, 1.4, 0], rotation: [0, 0, 0, 1] };

describe('messages from the native shell', () => {
  it('takes a pose, normalising its rotation', () => {
    const m = parseNativeMessage({ type: 'pose', t: 1, pose: { position: [0, 1, 2], rotation: [0, 0, 0, 1.2] }, fovDeg: 60, tracking: 'normal', floorY: 0 });
    expect(m).toEqual({ type: 'pose', t: 1, pose: { position: [0, 1, 2], rotation: [0, 0, 0, 1] }, fovDeg: 60, tracking: 'normal', floorY: 0 });
  });

  it('takes the same message as a JSON string, as the shells send it', () => {
    expect(parseNativeMessage(JSON.stringify({ type: 'session', state: 'running' }))).toEqual({ type: 'session', state: 'running' });
  });

  it('refuses what does not parse, rather than half-trusting it', () => {
    for (const bad of [
      'nonsense', null, 42, [], { type: 'launch' },
      { type: 'pose', t: 1, pose, fovDeg: 500, tracking: 'normal' },
      { type: 'pose', t: 1, pose: { position: [0, 1], rotation: [0, 0, 0, 1] }, fovDeg: 60 },
      { type: 'pose', t: 1, pose: { position: [0, 1, Number.NaN], rotation: [0, 0, 0, 1] }, fovDeg: 60 },
      { type: 'pose', t: 1, pose: { position: [0, 1, 2], rotation: [0, 0, 0, 0] }, fovDeg: 60 },
      { type: 'camera-image', t: 1, image: 'javascript:alert(1)', width: 10, height: 10, pose, fovDeg: 60 },
      { type: 'hello', version: 1, platform: 'windows' },
      { type: 'session', state: 'exploded' },
    ]) {
      expect(parseNativeMessage(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('caps what a shell can put into the page', () => {
    const m = parseNativeMessage({ type: 'session', state: 'failed', reason: 'x'.repeat(5000) });
    expect(m?.type === 'session' && m.reason?.length).toBe(300);
  });
});

describe('the bridge', () => {
  afterEach(() => {
    resetNativeBridge();
    delete (window as unknown as { SpatialNativeHost?: unknown }).SpatialNativeHost;
  });

  it('is there only inside a shell', () => {
    expect(nativeHostAvailable()).toBe(false);
    expect(nativeBridge()).toBeUndefined();
  });

  it('sends JSON to the Android host and hands back only valid messages', () => {
    const sent: string[] = [];
    (window as unknown as { SpatialNativeHost: unknown }).SpatialNativeHost = { postMessage: (j: string) => sent.push(j) };
    const bridge = nativeBridge()!;
    const got: string[] = [];
    bridge.subscribe((m) => got.push(m.type));
    bridge.send({ type: 'request-image', maxWidth: 480 });
    expect(sent).toEqual(['{"type":"request-image","maxWidth":480}']);
    const receive = (window as unknown as { spatialNative: { receive(m: unknown): void } }).spatialNative.receive;
    receive('{"type":"hello","version":1,"platform":"android","appVersion":"1","cameraImages":true}');
    receive('garbage');
    expect(got).toEqual(['hello']);
    expect(bridge.hello()?.cameraImages).toBe(true);
  });
});
