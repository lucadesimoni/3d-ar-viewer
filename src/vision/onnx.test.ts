import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisionModel, validateModelConfig } from './onnx';

const f = vi.hoisted(() => ({ create: vi.fn(), release: vi.fn() }));
vi.mock('onnxruntime-web', () => ({
  env: { wasm: {} },
  InferenceSession: { create: f.create },
}));

beforeEach(() => {
  vi.clearAllMocks();
  f.release.mockResolvedValue(undefined);
  f.create.mockResolvedValue({ release: f.release });
  vi.stubGlobal('navigator', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('VisionModel loading', () => {
  it('retains load diagnostics', async () => {
    f.create.mockRejectedValue(new Error('Model fetch failed'));
    const model = new VisionModel({ url: '/parts.onnx', inputSize: 32 }, 'detection');
    expect(await model.load()).toBe(false);
    expect(model.error).toContain('wasm: Model fetch failed');
    expect(model.ready).toBe(false);
  });

  it('retries failed WebGPU on WASM and retains the reason', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({}) } });
    f.create.mockRejectedValueOnce(new Error('GPU compilation failed'));
    const model = new VisionModel({ url: '/parts.onnx', inputSize: 32 }, 'detection');
    expect(await model.load()).toBe(true);
    expect(model.provider).toBe('wasm');
    expect(model.error).toContain('GPU compilation failed');
    expect(f.create).toHaveBeenLastCalledWith('/parts.onnx', expect.objectContaining({ executionProviders: ['wasm'] }));
  });

  it('releases sessions that finish loading after disposal without reviving the model', async () => {
    let finish!: (session: { release: typeof f.release }) => void;
    f.create.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const model = new VisionModel({ url: '/parts.onnx', inputSize: 32 }, 'detection');
    const loading = model.load();
    await vi.waitFor(() => expect(f.create).toHaveBeenCalled());
    model.dispose();
    finish({ release: f.release });
    expect(await loading).toBe(false);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(model.ready).toBe(false);
    expect(model.provider).toBeUndefined();
    expect(await model.load()).toBe(false);
  });

  it('shares concurrent loads and disposes idempotently', async () => {
    const model = new VisionModel({ url: '/parts.onnx', inputSize: 32 }, 'detection');
    await Promise.all([model.load(), model.load()]);
    expect(f.create).toHaveBeenCalledTimes(1);
    model.dispose();
    model.dispose();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid config before loading the runtime session', async () => {
    const model = new VisionModel({ url: '/parts.onnx', inputSize: 32, labels: ['sku', 'sku'] }, 'detection');
    expect(await model.load()).toBe(false);
    expect(model.error).toContain('unique');
    expect(f.create).not.toHaveBeenCalled();
    expect(() => validateModelConfig({ url: '', inputSize: 32 })).toThrow('URL');
    expect(() => validateModelConfig({ url: '/x', inputSize: -1 })).toThrow('inputSize');
    expect(() => validateModelConfig({ url: '/x', inputSize: 32, std: [1, 0, 1] })).toThrow('std');
  });
});
