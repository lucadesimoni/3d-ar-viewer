import { describe, expect, it } from 'vitest';
import { COCO_LABELS, recommendedPipelineConfig, remapLabels, yoloDetector } from './defaultModels';

describe('yoloDetector', () => {
  it('produces a YOLOv8/COCO detector config', () => {
    const c = yoloDetector('https://cdn/model.onnx');
    expect(c.inputSize).toBe(640);
    expect(c.format).toBe('yolov8');
    expect(c.labels).toHaveLength(80);
    expect(COCO_LABELS[0]).toBe('person');
  });
});

describe('recommendedPipelineConfig', () => {
  it('is geometry-only when no model URLs are provided', () => {
    const c = recommendedPipelineConfig({});
    expect(c.detector).toBeUndefined();
    expect(c.temporal).toBe(true);
    expect(c.softNms).toBe(true);
  });
  it('wires a detector when a URL is given', () => {
    const c = recommendedPipelineConfig({ detectorUrl: 'https://cdn/yolo.onnx' });
    expect(c.detector?.url).toBe('https://cdn/yolo.onnx');
    expect(c.detector?.format).toBe('yolov8');
  });
});

describe('remapLabels', () => {
  it('maps model class names to part IDs, leaving others intact', () => {
    const out = remapLabels(['bottle', 'cup'], { bottle: 'cap-left' });
    expect(out).toEqual(['cap-left', 'cup']);
  });
});
