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
import { DetectionTracker, ClassificationVoter, type Track } from './tracking';
import { remapLabels } from './defaultModels';
import {
  errorMessage,
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
  /** Temporal smoothing of detections/classification. On by default. */
  temporal?: boolean;
  /** Use soft-NMS instead of hard NMS in detection. */
  softNms?: boolean;
  /**
   * Model label -> runtime part/occurrence IDs. When supplied, this is an
   * allowlist: unmapped classes remain unknown. Multiple IDs describe repeated
   * indistinguishable parts, not a confirmed occurrence, pose or seating.
   * Without a mapping, explicitly configured labels are treated as exact IDs.
   */
  labelMapping?: Record<string, string | readonly string[]>;
}

export interface FrameResult {
  ts: number;
  /** False when the frame was rejected as too blurred to use. */
  accepted: boolean;
  sharpness: number;
  detections: Detection[];
  /** Temporally-smoothed, confirmed detections — the signal to drive UI from. */
  tracks: Track[];
  classification?: Classification[];
  /** Majority-voted class over a rolling window, when temporal is on. */
  votedClass?: { classId: number; label: string; confidence: number; partIds?: readonly string[] };
  segmentation?: Segmentation;
  /**
   * The region inference was narrowed to, in pixels of the frame handed in.
   *
   * Detections are always reported against the *whole* frame, whether or not
   * one was used; this says what was actually looked at, so a caller can tell
   * "nothing there" from "nowhere was looked".
   */
  roi?: { x: number; y: number; w: number; h: number };
  /** Whole-frame inference wall time, ms. */
  latencyMs: number;
}

/**
 * The rectangle `crop` will actually take.
 *
 * `crop` clamps to the image and floors to whole pixels, so the region the
 * model sees is not necessarily the region it was asked for. Mapping a
 * detection back through the *asked* rectangle instead of the *taken* one puts
 * it a few pixels out at every edge of the frame, which is exactly where a part
 * being half out of view already makes the answer hardest.
 */
export function clampRoi(
  image: { width: number; height: number },
  roi: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.floor(roi.x));
  const y = Math.max(0, Math.floor(roi.y));
  return {
    x,
    y,
    w: Math.max(1, Math.min(image.width, Math.floor(roi.x + roi.w)) - x),
    h: Math.max(1, Math.min(image.height, Math.floor(roi.y + roi.h)) - y),
  };
}

/**
 * A box the model reported inside a cutout, in the whole frame's terms.
 *
 * Both are normalised 0..1 — the model's against the cutout, the result against
 * the frame — which is precisely why the mistake was invisible: the numbers
 * stay in range and simply mean somewhere else.
 */
export function toFullFrame(
  box: { x: number; y: number; w: number; h: number },
  region: { x: number; y: number; w: number; h: number },
  image: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: (region.x + box.x * region.w) / image.width,
    y: (region.y + box.y * region.h) / image.height,
    w: (box.w * region.w) / image.width,
    h: (box.h * region.h) / image.height,
  };
}

export interface PipelineStatus {
  openCv: boolean;
  detector: boolean;
  classifier: boolean;
  segmenter: boolean;
  provider?: string;
  /** Per-capability diagnostics; a ready WASM model may retain its WebGPU failure. */
  errors?: Partial<Record<'config' | 'openCv' | 'detector' | 'classifier' | 'segmenter', string>>;
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
  private disposed = false;
  private generation = 0;
  private initializing: Promise<PipelineStatus> | undefined;
  private readonly errors: NonNullable<PipelineStatus['errors']> = {};
  private readonly tracker = new DetectionTracker();
  private readonly voter = new ClassificationVoter();

  constructor(private readonly config: PipelineConfig = {}) {}

  /** Kick off all lazy loads. Safe to call before the camera is live. */
  init(): Promise<PipelineStatus> {
    if (this.disposed) return Promise.resolve(this.status());
    return this.initializing ??= this.initialize();
  }

  private async initialize(): Promise<PipelineStatus> {
    try {
      validatePipelineConfig(this.config);
    } catch (error) {
      this.errors.config = errorMessage(error);
      return this.status();
    }
    const tasks: Promise<unknown>[] = [];

    tasks.push(
      loadOpenCV(this.config.openCvUrl).then((cv) => {
        if (this.disposed) return;
        this.openCvReady = cv !== undefined;
        if (!cv) this.errors.openCv = 'OpenCV unavailable; using JavaScript image processing.';
      }).catch((error) => { if (!this.disposed) this.errors.openCv = errorMessage(error); }),
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
      errors: {
        ...(this.detector?.error ? { detector: this.detector.error } : {}),
        ...(this.classifier?.error ? { classifier: this.classifier.error } : {}),
        ...(this.segmenter?.error ? { segmenter: this.segmenter.error } : {}),
        ...this.errors,
      },
    };
  }

  /**
   * Preprocess and run inference on one frame.
   *
   * `roi` narrows attention to a region (e.g. the box the geometry says the
   * active part should occupy), which both speeds up inference and cuts false
   * detections from the cluttered rest of the bench.
   *
   * Detections come back against the whole frame either way — see `toFullFrame`.
   * A segmentation mask does not: it is the model's own raster, and nothing
   * calls for one today (`runSegmentation` has no caller), so it is left in the
   * frame it was produced in rather than silently half-corrected.
   */
  async process(
    image: ImageData,
    opts: { roi?: { x: number; y: number; w: number; h: number }; runSegmentation?: boolean } = {},
  ): Promise<FrameResult | undefined> {
    if (this.busy || this.disposed || this.errors.config) return undefined;
    this.busy = true;
    const generation = this.generation;
    const start = performance.now();
    const ts = Date.now();

    try {
      const sharp = measureSharpness(image, this.config.sharpnessThreshold ?? 90);
      if (!sharp.sharp) {
        this.tracker.update([]);
        this.voter.reset();
        return { ts, accepted: false, sharpness: sharp.variance, detections: [], tracks: [], latencyMs: performance.now() - start };
      }

      // The rectangle `crop` will actually take, computed here so the boxes
      // that come back can be put where they belong. Anything that narrows the
      // frame narrows what the model's coordinates mean, and nothing used to
      // widen them again: every detection would have been reported against the
      // cutout, at the wrong place in the picture, and the tracker — which
      // matches boxes between frames — would have been comparing them across a
      // rectangle that moves with the operator's hand.
      const region = opts.roi ? clampRoi(image, opts.roi) : undefined;
      let frame = region ? crop(image, region.x, region.y, region.w, region.h) : image;
      if ((this.config.normalizeLighting ?? true) && this.openCvReady) {
        frame = normalizeIllumination(frame);
      }

      const [rawDetections, rawClassification, segmentation] = await Promise.all([
        this.detector?.ready ? this.detector.detect(frame, 0.35, 0.45, { soft: this.config.softNms }).catch((error) => {
          if (generation === this.generation) this.errors.detector = errorMessage(error);
          return [];
        }) : Promise.resolve<Detection[]>([]),
        this.classifier?.ready ? this.classifier.classify(frame).catch((error) => {
          if (generation === this.generation) this.errors.classifier = errorMessage(error);
          return undefined;
        }) : Promise.resolve<Classification[] | undefined>(undefined),
        opts.runSegmentation && this.segmenter?.ready
          ? this.segmenter.segment(frame).catch((error) => {
            if (generation === this.generation) this.errors.segmenter = errorMessage(error);
            return undefined;
          })
          : Promise.resolve<Segmentation | undefined>(undefined),
      ]);
      if (this.disposed || generation !== this.generation) return undefined;
      const detections = rawDetections
        .map((d) => (region ? { ...d, box: toFullFrame(d.box, region, image) } : d))
        .map((d) => this.resolveIdentity(d, this.config.detector));
      const classification = rawClassification?.map((c) => this.resolveIdentity(c, this.config.classifier));

      const temporal = this.config.temporal ?? true;
      const tracks = temporal ? this.tracker.update(detections) : detections.map(detToTrack);
      let votedClass: FrameResult['votedClass'];
      if (temporal && classification && classification[0]) {
        this.voter.push(classification[0].classId, classification[0].label, classification[0].score);
        votedClass = this.voter.vote();
        if (votedClass) {
          votedClass.partIds = this.resolveIdentity(votedClass, this.config.classifier).partIds;
        }
      } else {
        this.voter.reset();
      }

      return {
        ts,
        accepted: true,
        sharpness: sharp.variance,
        ...(region ? { roi: region } : {}),
        detections,
        tracks,
        classification: classification ?? undefined,
        votedClass,
        segmentation: segmentation ?? undefined,
        latencyMs: performance.now() - start,
      };
    } finally {
      this.busy = false;
    }
  }

  /** Clear temporal history — call when the active step or the workpiece changes. */
  resetTemporal(): void {
    this.generation++;
    this.tracker.reset();
    this.voter.reset();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resetTemporal();
    this.openCvReady = false;
    this.detector?.dispose();
    this.classifier?.dispose();
    this.segmenter?.dispose();
  }

  private resolveIdentity<T extends { classId: number; label: string }>(value: T, model?: ModelConfig): T & { partIds: readonly string[] } {
    const sourceLabel = model?.labels?.[value.classId];
    // Numeric fallback labels (class_0 etc.) are display-only, not part IDs.
    if (!sourceLabel) return { ...value, partIds: [] };
    const mapping = this.config.labelMapping;
    const target = mapping
      ? (Object.hasOwn(mapping, sourceLabel) ? mapping[sourceLabel] : [])
      : sourceLabel;
    const partIds = typeof target === 'string' ? [target] : [...target];
    const label = partIds.length === 1
      ? remapLabels([sourceLabel], { [sourceLabel]: partIds[0] })[0]
      : sourceLabel;
    return { ...value, label, partIds };
  }
}

export function validatePipelineConfig(config: PipelineConfig): void {
  if (config.sharpnessThreshold !== undefined && (!Number.isFinite(config.sharpnessThreshold) || config.sharpnessThreshold < 0)) {
    throw new Error('sharpnessThreshold must be a finite, non-negative number.');
  }
  const labels = new Set([...(config.detector?.labels ?? []), ...(config.classifier?.labels ?? [])]);
  for (const [label, target] of Object.entries(config.labelMapping ?? {})) {
    if (!labels.has(label)) throw new Error(`Mapped class "${label}" is not in the detector/classifier labels.`);
    const ids = typeof target === 'string' ? [target] : target;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim())
      || new Set(ids).size !== ids.length) {
      throw new Error(`Mapping for "${label}" must contain unique, non-empty part IDs.`);
    }
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
  const strong = detections.filter((d) => d.score >= minScore
    && (d.partIds === undefined || d.partIds.length === 1));
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

/** Wrap a raw detection as a (single-frame) track when temporal fusion is off. */
function detToTrack(d: Detection, i: number): Track {
  return { id: i, label: d.label, partIds: d.partIds, classId: d.classId, box: d.box, score: d.score, hits: 1, misses: 0, age: 1, confirmed: true };
}
