import { describe, expect, it, vi } from 'vitest';
import { RecognitionPipeline } from './pipeline';
import type { Detection } from './onnx';

const f = vi.hoisted(() => ({
  detect: vi.fn(),
  crop: vi.fn((img: ImageData, x: number, y: number, w: number, h: number) => {
    void img; void x; void y;
    return { width: w, height: h } as ImageData;
  }),
}));
vi.mock('./opencv', () => ({
  loadOpenCV: async () => undefined,
  measureSharpness: () => ({ sharp: true, variance: 100 }),
  crop: f.crop,
  normalizeIllumination: (i: ImageData) => i,
}));
vi.mock('./onnx', async (original) => ({
  ...await original<typeof import('./onnx')>(),
  VisionModel: class {
    ready = true;
    error: string | undefined;
    async load(): Promise<void> {}
    detect = f.detect;
    dispose(): void {}
  },
}));

const image = { width: 480, height: 640 } as ImageData;
const detected = (box: Detection['box']): Detection => ({ label: 'bracket', classId: 0, score: 0.9, box });

const pipeline = async () => {
  const p = new RecognitionPipeline({
    detector: { url: '/parts.onnx', inputSize: 32, labels: ['bracket'] },
    normalizeLighting: false,
    temporal: false,
  });
  await p.init();
  return p;
};

describe('inference narrowed to a region', () => {
  it('reports the detection where it is in the picture, not in the cutout', async () => {
    // The trap this seam was left in: `process` cropped and handed the model's
    // own coordinates straight back. They stay inside 0..1 and simply mean
    // somewhere else — the overlay draws the part in the middle of the view
    // while it sits in the corner, and the tracker matches boxes across a
    // rectangle that moves with the operator's hand.
    f.detect.mockResolvedValue([detected({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 })]);
    const p = await pipeline();
    const result = await p.process(image, { roi: { x: 240, y: 320, w: 240, h: 320 } });
    expect(f.crop).toHaveBeenCalledWith(image, 240, 320, 240, 320);
    expect(result?.detections[0].box.x).toBeCloseTo(0.75, 6);
    expect(result?.detections[0].box.y).toBeCloseTo(0.75, 6);
    expect(result?.detections[0].box.w).toBeCloseTo(0.1, 6);
    // And the file says what was actually looked at, so "nothing there" can be
    // told apart from "nowhere was looked".
    expect(result?.roi).toEqual({ x: 240, y: 320, w: 240, h: 320 });
    p.dispose();
  });

  it('changes nothing at all when no region is given', async () => {
    f.crop.mockClear();
    f.detect.mockResolvedValue([detected({ x: 0.25, y: 0.75, w: 0.5, h: 0.1 })]);
    const p = await pipeline();
    const result = await p.process(image);
    expect(f.crop).not.toHaveBeenCalled();
    expect(result?.detections[0].box).toEqual({ x: 0.25, y: 0.75, w: 0.5, h: 0.1 });
    expect(result?.roi).toBeUndefined();
    p.dispose();
  });

  it('maps through the cutout that was taken, not the one that was asked for', async () => {
    f.detect.mockResolvedValue([detected({ x: 0, y: 0, w: 1, h: 1 })]);
    const p = await pipeline();
    // Asked for a region hanging off two edges; `crop` clamps, so the mapping
    // has to clamp identically or every detection near a frame edge is out by
    // the overhang — and the edge is where a half-visible part is hardest.
    const result = await p.process(image, { roi: { x: -40, y: 600, w: 200, h: 200 } });
    expect(f.crop).toHaveBeenCalledWith(image, 0, 600, 160, 40);
    expect(result?.detections[0].box.x).toBe(0);
    expect(result?.detections[0].box.y).toBeCloseTo(600 / 640, 6);
    expect(result?.detections[0].box.w).toBeCloseTo(160 / 480, 6);
    p.dispose();
  });
});
