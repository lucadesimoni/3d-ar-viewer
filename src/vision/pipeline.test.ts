import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecognitionPipeline, type PipelineConfig } from './pipeline';
import { classifyRecognition } from './verdict';
import type { Detection } from './onnx';

const f = vi.hoisted(() => ({
  detect: vi.fn(),
  classify: vi.fn(),
  load: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('./opencv', () => ({
  loadOpenCV: async () => undefined,
  measureSharpness: () => ({ sharp: true, variance: 100 }),
}));
vi.mock('./onnx', async (original) => ({
  ...await original<typeof import('./onnx')>(),
  VisionModel: class {
    ready = true;
    error: string | undefined;
    load = f.load;
    detect = f.detect;
    classify = f.classify;
    dispose = f.dispose;
  },
}));

const image = {} as ImageData;
const detection = (label: string, classId = 0): Detection => ({
  label, classId, score: 0.95, box: { x: 0, y: 0, w: 0.5, h: 0.5 },
});
const config: PipelineConfig = {
  detector: { url: '/parts.onnx', inputSize: 32, labels: ['bracket', 'cup'] },
  normalizeLighting: false,
  temporal: false,
};
const info = {
  known: new Map([['occ-1', 'Bracket'], ['occ-2', 'Bracket'], ['cup', 'Cup'], ['class_0', 'Other']]),
  expected: new Set(['occ-1', 'cup', 'class_0']),
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  f.load.mockResolvedValue(true);
  f.detect.mockResolvedValue([detection('bracket')]);
  f.classify.mockResolvedValue([]);
});

describe('recognition label contract', () => {
  it('maps trained class labels to runtime IDs before tracking and verdicts', async () => {
    const pipeline = new RecognitionPipeline({ ...config, labelMapping: { bracket: 'occ-1' } });
    await pipeline.init();
    const result = await pipeline.process(image);
    expect(result?.tracks[0]).toMatchObject({ label: 'occ-1', partIds: ['occ-1'] });
    expect(classifyRecognition(result!.tracks, info).verdict).toBe('correct');
  });

  it('treats explicit mapping as an allowlist even when an unmapped label equals a known ID', async () => {
    f.detect.mockResolvedValue([detection('cup', 1)]);
    const pipeline = new RecognitionPipeline({ ...config, labelMapping: { bracket: 'occ-1' } });
    await pipeline.init();
    const result = await pipeline.process(image);
    expect(classifyRecognition(result!.tracks, info).objects[0].status).toBe('unknown');
  });

  it('never guesses a repeated SKU occurrence from the active step', async () => {
    const pipeline = new RecognitionPipeline({ ...config, labelMapping: { bracket: ['occ-1', 'occ-2'] } });
    await pipeline.init();
    const result = await pipeline.process(image);
    expect(classifyRecognition(result!.tracks, info)).toMatchObject({
      verdict: 'searching', objects: [{ label: 'bracket', status: 'unknown' }],
    });
  });

  it('keeps generated numeric labels unknown but permits explicitly configured exact IDs', async () => {
    f.detect.mockResolvedValue([detection('class_0')]);
    const pipeline = new RecognitionPipeline({ ...config, detector: { url: '/x', inputSize: 32 } });
    await pipeline.init();
    expect(classifyRecognition((await pipeline.process(image))!.tracks, info).verdict).toBe('searching');
    f.detect.mockResolvedValue([detection('cup', 1)]);
    const direct = new RecognitionPipeline(config);
    await direct.init();
    expect(classifyRecognition((await direct.process(image))!.tracks, info).verdict).toBe('correct');
  });

  it('reports invalid mappings without downloading models', async () => {
    const pipeline = new RecognitionPipeline({ ...config, labelMapping: { typo: 'occ-1' } });
    expect((await pipeline.init()).errors?.config).toContain('typo');
    expect(f.load).not.toHaveBeenCalled();
    expect(await pipeline.process(image)).toBeUndefined();
  });
});

describe('pipeline lifecycle', () => {
  it('retains the no-model baseline', async () => {
    const pipeline = new RecognitionPipeline();
    expect(await pipeline.init()).toMatchObject({ detector: false, classifier: false, segmenter: false });
    expect((await pipeline.process(image))?.tracks).toEqual([]);
    expect(f.load).not.toHaveBeenCalled();
  });

  it.each(['resetTemporal', 'dispose'] as const)('drops an in-flight result after %s', async (action) => {
    const pending = deferred<Detection[]>();
    f.detect.mockReturnValueOnce(pending.promise);
    const pipeline = new RecognitionPipeline({ ...config, temporal: true });
    await pipeline.init();
    const processing = pipeline.process(image);
    pipeline[action]();
    pending.resolve([detection('bracket')]);
    expect(await processing).toBeUndefined();
    if (action === 'resetTemporal') {
      expect((await pipeline.process(image))?.tracks).toEqual([]);
    } else {
      expect(await pipeline.process(image)).toBeUndefined();
    }
  });

  it('initializes once and retains inference errors without rejecting the frame loop', async () => {
    const pipeline = new RecognitionPipeline(config);
    await Promise.all([pipeline.init(), pipeline.init()]);
    expect(f.load).toHaveBeenCalledTimes(1);
    f.detect.mockRejectedValueOnce(new Error('Output labels mismatch'));
    expect((await pipeline.process(image))?.tracks).toEqual([]);
    expect(pipeline.status().errors?.detector).toBe('Output labels mismatch');
  });
});
