/**
 * ONNX Runtime Web inference for the recognition pipeline.
 *
 * Three model shapes cover what an assembly-AR app needs to understand a scene:
 *  - detection: where are the parts / fixtures / hands in the frame,
 *  - segmentation: which pixels belong to the workpiece (drives occlusion masks),
 *  - classification: is the part in view the correct one for this step, and is it
 *    the right hand (left/right variant) — the ML backstop to the geometric
 *    swap-detection the engine already does.
 *
 * The runtime is loaded lazily and prefers the WebGPU execution provider (a huge
 * speedup on modern iPads), falling back to WASM with SIMD + threads. Models are
 * not bundled — they are fetched from a caller-supplied URL — so the app ships
 * small and a deployment drops in whatever weights it has trained.
 */

import type { InferenceSession, Tensor } from 'onnxruntime-web';
import { bilinearResize, letterbox, unletterboxBox, type LetterboxResult } from './preprocess';

export type ExecutionProvider = 'webgpu' | 'wasm';

export interface ModelConfig {
  url: string;
  /** Square input side the model expects, px. */
  inputSize: number;
  /** Model input tensor name; defaults to the first input. */
  inputName?: string;
  layout?: 'nchw' | 'nhwc';
  /** Per-channel mean/std normalization, in 0..1 units. */
  mean?: [number, number, number];
  std?: [number, number, number];
  /** Class names indexed by the model's output order. */
  labels?: string[];
  /**
   * Detection output format. 'yolov5' has an objectness column ([1, N, 5+C]);
   * 'yolov8' (also YOLO11) is transposed and has none ([1, 4+C, N]). 'auto'
   * infers from the output dims — the transposed axis is the shorter one.
   */
  format?: 'yolov5' | 'yolov8' | 'auto';
}

export interface Detection {
  label: string;
  classId: number;
  score: number;
  /** Normalised 0..1 box in the *preprocessed* frame: x, y, w, h. */
  box: { x: number; y: number; w: number; h: number };
}

export interface Classification {
  label: string;
  classId: number;
  score: number;
}

export interface Segmentation {
  width: number;
  height: number;
  /** Per-pixel class id, row-major. */
  mask: Uint8Array;
  labels: string[];
}

let ortPromise: Promise<typeof import('onnxruntime-web') | undefined> | undefined;

/** Load ORT web once; resolves `undefined` where it cannot run. */
export function loadOrt(): Promise<typeof import('onnxruntime-web') | undefined> {
  if (ortPromise) return ortPromise;
  ortPromise = import('onnxruntime-web')
    .then((ort) => {
      // Multi-threaded WASM needs cross-origin isolation; single-thread otherwise.
      const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      ort.env.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      ort.env.wasm.simd = true;
      // ORT fetches its own .wasm binaries at runtime. Rather than bundle and
      // serve them, point at a pinned CDN matching the installed version so a
      // deployment needs no extra asset wiring. Override env.wasm.wasmPaths at
      // startup if you prefer to self-host them.
      const version = (ort.env as { versions?: { common?: string } }).versions?.common ?? '1.19.2';
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
      return ort;
    })
    .catch(() => undefined);
  return ortPromise;
}

async function pickProviders(): Promise<ExecutionProvider[]> {
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
  if (hasWebGPU) {
    try {
      const adapter = await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } })
        .gpu!.requestAdapter();
      if (adapter) return ['webgpu', 'wasm'];
    } catch {
      /* fall through to wasm */
    }
  }
  return ['wasm'];
}

/**
 * A loaded model plus the pre/post-processing that turns a frame into typed
 * results. One instance wraps one ONNX graph and one task shape.
 */
export class VisionModel {
  private session: InferenceSession | undefined;
  private ort: typeof import('onnxruntime-web') | undefined;
  provider: ExecutionProvider | undefined;

  constructor(
    readonly config: ModelConfig,
    readonly task: 'detection' | 'segmentation' | 'classification',
  ) {}

  get ready(): boolean {
    return this.session !== undefined;
  }

  async load(): Promise<boolean> {
    this.ort = await loadOrt();
    if (!this.ort) return false;
    const providers = await pickProviders();
    try {
      this.session = await this.ort.InferenceSession.create(this.config.url, {
        executionProviders: providers,
        graphOptimizationLevel: 'all',
      });
      this.provider = providers[0];
      return true;
    } catch {
      // WebGPU can fail to compile a graph; retry once pinned to WASM.
      if (providers[0] !== 'wasm') {
        try {
          this.session = await this.ort.InferenceSession.create(this.config.url, {
            executionProviders: ['wasm'],
          });
          this.provider = 'wasm';
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /** Aspect-correct preprocessing into the model's input tensor. */
  private makeInputTensor(image: ImageData, useLetterbox: boolean): { tensor: Tensor; lb?: LetterboxResult } {
    if (!this.ort) throw new Error('ORT not loaded');
    const size = this.config.inputSize;
    let lb: LetterboxResult | undefined;
    let resized: ImageData;
    if (useLetterbox) {
      lb = letterbox(image, size);
      resized = lb.image;
    } else {
      resized = bilinearResize(image, size, size);
    }
    const mean = this.config.mean ?? [0, 0, 0];
    const std = this.config.std ?? [1, 1, 1];
    const layout = this.config.layout ?? 'nchw';
    const data = new Float32Array(size * size * 3);

    for (let i = 0; i < size * size; i++) {
      const r = resized.data[i * 4] / 255;
      const g = resized.data[i * 4 + 1] / 255;
      const b = resized.data[i * 4 + 2] / 255;
      const nr = (r - mean[0]) / std[0];
      const ng = (g - mean[1]) / std[1];
      const nb = (b - mean[2]) / std[2];
      if (layout === 'nchw') {
        data[i] = nr;
        data[size * size + i] = ng;
        data[2 * size * size + i] = nb;
      } else {
        data[i * 3] = nr;
        data[i * 3 + 1] = ng;
        data[i * 3 + 2] = nb;
      }
    }
    const dims = layout === 'nchw' ? [1, 3, size, size] : [1, size, size, 3];
    return { tensor: new this.ort.Tensor('float32', data, dims), lb };
  }

  private async run(image: ImageData, useLetterbox = false): Promise<{ out: Record<string, Tensor>; lb?: LetterboxResult }> {
    if (!this.session || !this.ort) throw new Error('Model not loaded');
    const { tensor, lb } = this.makeInputTensor(image, useLetterbox);
    const name = this.config.inputName ?? this.session.inputNames[0];
    const out = (await this.session.run({ [name]: tensor })) as unknown as Record<string, Tensor>;
    return { out, lb };
  }

  private label(classId: number): string {
    return this.config.labels?.[classId] ?? `class_${classId}`;
  }

  /** Classification: argmax + softmax over the single output vector. */
  async classify(image: ImageData, topK = 3): Promise<Classification[]> {
    const { out } = await this.run(image, false);
    const logits = firstTensor(out);
    if (!logits) return [];
    const scores = softmax(Array.from(logits.data as Float32Array));
    return scores
      .map((score, classId) => ({ classId, score, label: this.label(classId) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Detection: decodes a YOLO-style `[1, N, 5+C]` output — box centre/size, an
   * objectness score, then per-class scores — with class-wise NMS. Boxes come
   * back normalised to the input square.
   */
  async detect(
    image: ImageData,
    scoreThreshold = 0.35,
    iouThreshold = 0.45,
    opts: { soft?: boolean } = {},
  ): Promise<Detection[]> {
    const { out, lb } = await this.run(image, true);
    const t = firstTensor(out);
    if (!t) return [];
    const dims = t.dims;
    if (dims.length < 3) return [];
    const a = dims[1] ?? 0;
    const b = dims[2] ?? 0;
    if (a === 0 || b === 0) return [];
    const data = t.data as Float32Array;
    const size = this.config.inputSize;

    // Resolve the output format. YOLOv8/YOLO11 emit [1, 4+C, N] (attrs on the
    // shorter axis, no objectness); YOLOv5 emits [1, N, 5+C] with objectness.
    let format = this.config.format ?? 'auto';
    if (format === 'auto') format = a < b ? 'yolov8' : 'yolov5';
    const v8 = format === 'yolov8';
    const numBoxes = v8 ? b : a;
    const attrs = v8 ? a : b;
    const numClasses = v8 ? attrs - 4 : attrs - 5;
    if (numClasses <= 0) return [];

    // Reading one attribute of box i: v8 is channel-major (stride numBoxes),
    // v5 is box-major (stride attrs).
    const at = v8
      ? (attr: number, i: number) => data[attr * numBoxes + i]
      : (attr: number, i: number) => data[i * attrs + attr];

    const raw: Detection[] = [];
    for (let i = 0; i < numBoxes; i++) {
      const obj = v8 ? 1 : at(4, i);
      if (!v8 && obj < scoreThreshold) continue;
      const classBase = v8 ? 4 : 5;
      let bestId = 0;
      let bestScore = 0;
      for (let c = 0; c < numClasses; c++) {
        const sc = at(classBase + c, i);
        if (sc > bestScore) { bestScore = sc; bestId = c; }
      }
      const score = obj * bestScore;
      if (score < scoreThreshold) continue;
      const cx = at(0, i) / size;
      const cy = at(1, i) / size;
      const w = at(2, i) / size;
      const h = at(3, i) / size;
      const boxInSquare = { x: cx - w / 2, y: cy - h / 2, w, h };
      const box = lb ? unletterboxBox(boxInSquare, lb) : boxInSquare;
      raw.push({ label: this.label(bestId), classId: bestId, score, box });
    }
    return opts.soft
      ? softNonMaxSuppression(raw, iouThreshold, scoreThreshold)
      : nonMaxSuppression(raw, iouThreshold);
  }

  /** Segmentation: argmax over a `[1, C, H, W]` output into a per-pixel mask. */
  async segment(image: ImageData): Promise<Segmentation | undefined> {
    const { out } = await this.run(image, false);
    const t = firstTensor(out);
    if (!t) return undefined;
    const [, classes, h, w] = t.dims as number[];
    if (!classes || !h || !w) return undefined;
    const data = t.data as Float32Array;
    const mask = new Uint8Array(h * w);
    const plane = h * w;
    for (let p = 0; p < plane; p++) {
      let best = 0;
      let bestV = -Infinity;
      for (let c = 0; c < classes; c++) {
        const v = data[c * plane + p];
        if (v > bestV) {
          bestV = v;
          best = c;
        }
      }
      mask[p] = best;
    }
    return { width: w, height: h, mask, labels: this.config.labels ?? [] };
  }

  dispose(): void {
    void this.session?.release?.();
    this.session = undefined;
  }
}

function firstTensor(out: Record<string, Tensor>): Tensor | undefined {
  const key = Object.keys(out)[0];
  return key ? out[key] : undefined;
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

export function iou(a: Detection['box'], b: Detection['box']): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Greedy per-class non-max suppression. */
export function nonMaxSuppression(dets: Detection[], iouThreshold: number): Detection[] {
  const byScore = [...dets].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const d of byScore) {
    if (kept.some((k) => k.classId === d.classId && iou(k.box, d.box) > iouThreshold)) continue;
    kept.push(d);
  }
  return kept;
}

/**
 * Soft non-max suppression (Gaussian).
 *
 * Hard NMS deletes any overlapping box outright, which drops a genuine second
 * part that happens to sit close to a stronger one — common in a dense assembly
 * where neighbouring components overlap in the camera view. Soft-NMS instead
 * *decays* an overlapping box's score by a Gaussian of the overlap, keeping it
 * if it still clears the threshold. That recovers real detections hard NMS would
 * have thrown away.
 */
export function softNonMaxSuppression(
  dets: Detection[],
  iouThreshold: number,
  scoreThreshold: number,
  sigma = 0.5,
): Detection[] {
  const pool = dets.map((d) => ({ ...d }));
  const kept: Detection[] = [];
  while (pool.length > 0) {
    let m = 0;
    for (let i = 1; i < pool.length; i++) if (pool[i].score > pool[m].score) m = i;
    const best = pool.splice(m, 1)[0];
    kept.push(best);
    for (const d of pool) {
      if (d.classId !== best.classId) continue;
      const ov = iou(best.box, d.box);
      if (ov > iouThreshold) d.score *= Math.exp(-(ov * ov) / sigma);
    }
    for (let i = pool.length - 1; i >= 0; i--) if (pool[i].score < scoreThreshold) pool.splice(i, 1);
  }
  return kept;
}

/** Nearest-neighbour resize into a fresh ImageData. */
export function resizeTo(image: ImageData, w: number, h: number): ImageData {
  if (image.width === w && image.height === h) return image;
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = image.width / w;
  const sy = image.height / h;
  for (let y = 0; y < h; y++) {
    const srcY = Math.min(image.height - 1, Math.floor(y * sy));
    for (let x = 0; x < w; x++) {
      const srcX = Math.min(image.width - 1, Math.floor(x * sx));
      const s = (srcY * image.width + srcX) * 4;
      const d = (y * w + x) * 4;
      out[d] = image.data[s];
      out[d + 1] = image.data[s + 1];
      out[d + 2] = image.data[s + 2];
      out[d + 3] = image.data[s + 3];
    }
  }
  return new ImageData(out, w, h);
}
