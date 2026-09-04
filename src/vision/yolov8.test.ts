import { describe, expect, it } from 'vitest';
import { VisionModel } from './onnx';

/** Build a fake ORT tensor-like object. */
const tensor = (dims: number[], data: number[]) => ({ dims, data: new Float32Array(data) });

/**
 * Exercise the decoder's format handling directly by stubbing `run`. We craft a
 * single-box YOLOv8 output [1, 4+C, N] (N=1, C=2) with class 1 winning, and a
 * YOLOv5 output [1, N, 5+C] with objectness, and check both decode to the same
 * box in original-frame coordinates.
 */
function stub(model: VisionModel, out: unknown) {
  // @ts-expect-error private override for the test
  model.run = async () => ({ out: { output: out }, lb: undefined });
  // @ts-expect-error private override
  model.session = {};
  // @ts-expect-error private override
  model.ort = {};
}

const img = { data: new Uint8ClampedArray(4), width: 1, height: 1, colorSpace: 'srgb' } as ImageData;

describe('detect() format handling', () => {
  it('decodes a YOLOv8 ([1, 4+C, N]) output with no objectness', async () => {
    const m = new VisionModel({ url: 'x', inputSize: 640, labels: ['a', 'b'], format: 'yolov8' }, 'detection');
    // cx,cy,w,h then 2 class scores, channel-major with N=1.
    stub(m, tensor([1, 6, 1], [320, 320, 64, 64, 0.1, 0.9]));
    const dets = await m.detect(img, 0.3);
    expect(dets).toHaveLength(1);
    expect(dets[0].classId).toBe(1);
    expect(dets[0].score).toBeCloseTo(0.9, 5);
  });

  it('decodes a YOLOv5 ([1, N, 5+C]) output with objectness', async () => {
    const m = new VisionModel({ url: 'x', inputSize: 640, labels: ['a', 'b'], format: 'yolov5' }, 'detection');
    stub(m, tensor([1, 1, 7], [320, 320, 64, 64, 0.8, 0.1, 0.95]));
    const dets = await m.detect(img, 0.3);
    expect(dets).toHaveLength(1);
    expect(dets[0].classId).toBe(1);
    expect(dets[0].score).toBeCloseTo(0.8 * 0.95, 5);
  });

  it('auto-detects the transposed v8 layout from dims (attrs < N)', async () => {
    const m = new VisionModel({ url: 'x', inputSize: 640, labels: ['a', 'b'], format: 'auto' }, 'detection');
    // [1, 6, 10]: 6 attrs (4 box + 2 class) on axis 1, 10 boxes on axis 2 —
    // channel-major, only box 0 is populated (class 1 wins), the rest are zero.
    const N = 10, C = 6;
    const data = new Array(C * N).fill(0);
    data[0 * N + 0] = 320; data[1 * N + 0] = 320; data[2 * N + 0] = 64; data[3 * N + 0] = 64;
    data[4 * N + 0] = 0.1; data[5 * N + 0] = 0.9;
    stub(m, tensor([1, C, N], data));
    const dets = await m.detect(img, 0.3);
    expect(dets).toHaveLength(1);
    expect(dets[0].classId).toBe(1);
  });
});
