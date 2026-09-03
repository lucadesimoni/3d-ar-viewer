/**
 * The recognition pipeline: raw camera frame in, structured scene understanding
 * out, ready to drive the AR overlay.
 *
 *   video frame
 *     └─ OpenCV.js:  sharpness gate → illumination normalization → (crop / warp)
 *          └─ ONNX Runtime Web:  detection + classification (+ optional segmentation)
 *               └─ result fused with the geometric engine's expectations
 *
 * The design goal is that everything is *optional and additive*. With neither
 * OpenCV nor a model loaded, the app is still a fully working guided-AR tool
 * driven by geometry alone; as each capability loads, the scene understanding
 * gets richer. That is what keeps first paint fast on a cold cellular connection
 * while the ~10 MB of WASM streams in behind it.
 */

import {
  crop,
  loadOpenCV,
  measureSharpness,
  normalizeIllumination,
  type Point2,
} from './opencv';
import {
  VisionModel,
  type Classification,
  type Detection,
  type ModelConfig,
  type Segmentation,
} from './onnx';

export interface PipelineConfig {
  openCvUrl?: string;
  detector?: ModelConfig;
  classifier?: ModelConfig;
  segmenter?: ModelConfig;
  /** Laplacian-variance floor below which a frame is skipped. */
  sharpnessThreshold?: number;
  /** Flatten lighting before inference. On by default. */
  normalizeLighting?: boolean;
}

export interface FrameResult {
  ts: number;
  /** False when the frame was rejected as too blurred to use. */
  accepted: boolean;
  sharpness: number;
  detections: Detection[];
  classification?: Classification[];
  segmentation?: Segmentation;
  /** Whole-frame inference wall time, ms. */
  latencyMs: number;
}

export interface PipelineStatus {
  openCv: boolean;
  detector: boolean;
  classifier: boolean;
  segmenter: boolean;
  provider?: string;
}

/**
 * Owns the loaded models and processes one frame at a time.
 *
 * `process` is re-entrancy-guarded: if a previous frame is still in flight the
 * new one is dropped rather than queued, because on a tablet a backlog of stale
 * frames is worse than a lower effective frame rate — you always want to be
 * reasoning about what the camera sees *now*.
 */
export class RecognitionPipeline {
  private detector: VisionModel | undefined;
  private classifier: VisionModel | undefined;
  private segmenter: VisionModel | undefined;
  private busy = false;
  private openCvReady = false;

  constructor(private readonly config: PipelineConfig = {}) {}

  /** Kick off all lazy loads. Safe to call before the camera is live. */
  async init(): Promise<PipelineStatus> {
    const tasks: Promise<unknown>[] = [];

    tasks.push(
      loadOpenCV(this.config.openCvUrl).then((cv) => {
        this.openCvReady = cv !== undefined;
      }),
    );
    if (this.config.detector) {
      this.detector = new VisionModel(this.config.detector, 'detection');
      tasks.push(this.detector.load());
    }
    if (this.config.classifier) {
      this.classifier = new VisionModel(this.config.classifier, 'classification');
      tasks.push(this.classifier.load());
    }
    if (this.config.segmenter) {
      this.segmenter = new VisionModel(this.config.segmenter, 'segmentation');
      tasks.push(this.segmenter.load());
    }

    await Promise.allSettled(tasks);
    return this.status();
  }

  status(): PipelineStatus {
    return {
      openCv: this.openCvReady,
      detector: this.detector?.ready ?? false,
      classifier: this.classifier?.ready ?? false,
      segmenter: this.segmenter?.ready ?? false,
      provider: this.detector?.provider ?? this.classifier?.provider,
    };
  }

  /**
   * Preprocess and run inference on one frame.
   *
   * `roi` narrows attention to a region (e.g. the box the geometry says the
   * active part should occupy), which both speeds up inference and cuts false
   * detections from the cluttered rest of the bench.
   */
  async process(
    image: ImageData,
    opts: { roi?: { x: number; y: number; w: number; h: number }; runSegmentation?: boolean } = {},
  ): Promise<FrameResult | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    const start = performance.now();
    const ts = Date.now();

    try {
      const sharp = measureSharpness(image, this.config.sharpnessThreshold ?? 90);
      if (!sharp.sharp) {
        return { ts, accepted: false, sharpness: sharp.variance, detections: [], latencyMs: performance.now() - start };
      }

      let frame = opts.roi ? crop(image, opts.roi.x, opts.roi.y, opts.roi.w, opts.roi.h) : image;
      if ((this.config.normalizeLighting ?? true) && this.openCvReady) {
        frame = normalizeIllumination(frame);
      }

      const [detections, classification, segmentation] = await Promise.all([
        this.detector?.ready ? this.detector.detect(frame) : Promise.resolve<Detection[]>([]),
        this.classifier?.ready ? this.classifier.classify(frame) : Promise.resolve<Classification[] | undefined>(undefined),
        opts.runSegmentation && this.segmenter?.ready
          ? this.segmenter.segment(frame)
          : Promise.resolve<Segmentation | undefined>(undefined),
      ]);

      return {
        ts,
        accepted: true,
        sharpness: sharp.variance,
        detections,
        classification: classification ?? undefined,
        segmentation: segmentation ?? undefined,
        latencyMs: performance.now() - start,
      };
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.detector?.dispose();
    this.classifier?.dispose();
    this.segmenter?.dispose();
  }
}

/**
 * Fuse a detection result against the part the step expects to see.
 *
 * The geometry engine already knows which part *should* be going in and whether
 * it is a handed variant; the detector says which part the camera actually sees.
 * When those disagree, that is an early, camera-side catch of a wrong-part pick —
 * before the operator has even tried to seat it.
 */
export interface ExpectationCheck {
  expectedLabel: string;
  seen: boolean;
  seenScore: number;
  /** A different, confidently-detected part is in the operator's hand. */
  wrongPartLabel?: string;
  wrongPartScore?: number;
}

export function checkExpectation(
  detections: Detection[],
  expectedLabel: string,
  minScore = 0.4,
): ExpectationCheck {
  const strong = detections.filter((d) => d.score >= minScore);
  const match = strong.find((d) => d.label === expectedLabel);
  const other = strong
    .filter((d) => d.label !== expectedLabel)
    .sort((a, b) => b.score - a.score)[0];

  return {
    expectedLabel,
    seen: match !== undefined,
    seenScore: match?.score ?? 0,
    wrongPartLabel: !match && other ? other.label : undefined,
    wrongPartScore: !match && other ? other.score : undefined,
  };
}

/** Map a marker's four detected corners into a canonical, face-on patch. */
export function markerCorners(det: Detection, frameW: number, frameH: number): [Point2, Point2, Point2, Point2] {
  const x = det.box.x * frameW;
  const y = det.box.y * frameH;
  const w = det.box.w * frameW;
  const h = det.box.h * frameH;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}
