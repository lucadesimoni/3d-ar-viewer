import type { ModelConfig } from './onnx';
import type { PipelineConfig } from './pipeline';

/**
 * Recommended public models for the recognition pipeline.
 *
 * There is no public ONNX model that recognises *your specific* assembly parts
 * by SKU — that always needs fine-tuning on your parts. What IS publicly
 * available and best-in-class as the detection backbone is **Ultralytics YOLO
 * (YOLO11 / YOLOv8)** exported to ONNX: real-time, small, runs in ONNX Runtime
 * Web with the WebGPU execution provider, and the community hosts ready COCO
 * weights. That is the strongest ready-to-run starting point for industrial AR,
 * and the pipeline's decoder already speaks its output format.
 *
 * Path to production recognition of real parts:
 *  1. Start from YOLO11n/YOLOv8n (below) to prove the on-device pipeline.
 *  2. Fine-tune on a few hundred labelled images of your parts (Ultralytics
 *     `yolo train`, then `yolo export format=onnx`), naming the classes after
 *     your part IDs so the on-part discrepancy overlay maps 1:1.
 *  3. Host the exported `.onnx` on your origin and set VITE_DETECTOR_MODEL_URL.
 *
 * The default URL is taken from the environment so nothing 404s out of the box;
 * point it at a model you host (or a verified public mirror).
 */

/** COCO-80 class names — the classes a stock YOLO model detects. */
export const COCO_LABELS: string[] = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog',
  'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
  'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich',
  'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote',
  'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book',
  'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

/**
 * The recommended default detector: Ultralytics YOLO (COCO), 640×640, ONNX.
 *
 * `format: 'yolov8'` matches YOLOv8/YOLO11 exports; the input is 0..1 normalised
 * (no mean/std), NCHW — the standard Ultralytics ONNX contract.
 */
export function yoloDetector(url: string): ModelConfig {
  return {
    url,
    inputSize: 640,
    layout: 'nchw',
    mean: [0, 0, 0],
    std: [1, 1, 1],
    labels: COCO_LABELS,
    format: 'yolov8',
  };
}

export interface DefaultModelEnv {
  detectorUrl?: string;
  classifierUrl?: string;
  segmenterUrl?: string;
  openCvUrl?: string;
}

/**
 * Build a PipelineConfig from environment/host-provided URLs. When no detector
 * URL is supplied the pipeline runs geometry-only (recognition simply stays
 * quiet) — the app is fully functional either way.
 */
export function recommendedPipelineConfig(env: DefaultModelEnv = {}): PipelineConfig {
  const cfg: PipelineConfig = { normalizeLighting: true, temporal: true, softNms: true };
  if (env.detectorUrl) cfg.detector = yoloDetector(env.detectorUrl);
  if (env.classifierUrl) cfg.classifier = { url: env.classifierUrl, inputSize: 224, layout: 'nchw', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };
  if (env.segmenterUrl) cfg.segmenter = { url: env.segmenterUrl, inputSize: 512, layout: 'nchw' };
  if (env.openCvUrl) cfg.openCvUrl = env.openCvUrl;
  return cfg;
}

/** Read model URLs from Vite env vars (VITE_DETECTOR_MODEL_URL, …). */
export function envModelConfig(): PipelineConfig {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return recommendedPipelineConfig({
    detectorUrl: env.VITE_DETECTOR_MODEL_URL,
    classifierUrl: env.VITE_CLASSIFIER_MODEL_URL,
    segmenterUrl: env.VITE_SEGMENTER_MODEL_URL,
    openCvUrl: env.VITE_OPENCV_URL,
  });
}

/**
 * Map model class labels to assembly part IDs so a stock/fine-tuned model drives
 * the on-part discrepancy overlay. A fine-tuned model whose classes are already
 * the part IDs needs no mapping; a stock COCO model needs one per part it can
 * stand in for during a demo. Returns a relabelled label list applier.
 */
export function remapLabels(labels: string[], mapping: Record<string, string>): string[] {
  return labels.map((l) => mapping[l] ?? l);
}
