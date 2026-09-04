import { describe, expect, it } from 'vitest';
import { applyPerfOverrides, classifyTier, profileForTier, type DeviceSignals } from './perf';

const sig = (o: Partial<DeviceSignals>): DeviceSignals => ({
  cores: 4, memoryGB: 4, dpr: 2, mobile: false, maxTextureSize: 8192, renderer: '', ...o,
});

describe('classifyTier', () => {
  it('rates a desktop workstation high', () => {
    expect(classifyTier(sig({ cores: 12, memoryGB: 16, mobile: false }))).toBe('high');
  });
  it('holds a mid-range mobile at mid', () => {
    expect(classifyTier(sig({ cores: 6, memoryGB: 4, mobile: true }))).toBe('mid');
  });
  it('promotes a high-end tablet (many cores + memory) back to high', () => {
    expect(classifyTier(sig({ cores: 8, memoryGB: 8, mobile: true }))).toBe('high');
  });
  it('forces software renderers to low regardless of cores', () => {
    expect(classifyTier(sig({ cores: 16, memoryGB: 32, renderer: 'google swiftshader' }))).toBe('low');
  });
  it('forces low on a tiny texture limit', () => {
    expect(classifyTier(sig({ cores: 8, maxTextureSize: 2048 }))).toBe('low');
  });
});

describe('profileForTier', () => {
  it('gives richer settings to higher tiers', () => {
    const hi = profileForTier('high');
    const lo = profileForTier('low');
    expect(hi.maxPixelRatio).toBeGreaterThan(lo.maxPixelRatio);
    expect(hi.targetFps).toBeGreaterThan(lo.targetFps);
    expect(hi.recognitionIntervalMs).toBeLessThan(lo.recognitionIntervalMs);
  });
});

describe('applyPerfOverrides', () => {
  it('forces a tier via ?perf=', () => {
    expect(applyPerfOverrides(profileForTier('high'), '?perf=low').tier).toBe('low');
  });
  it('?perf=max maxes quality and disables adaptive degradation', () => {
    const p = applyPerfOverrides(profileForTier('low'), '?perf=max');
    expect(p.adaptive).toBe(false);
    expect(p.maxPixelRatio).toBe(3);
  });
  it('caps dpr and fps from params', () => {
    const p = applyPerfOverrides(profileForTier('high'), '?dpr=1.5&fps=30');
    expect(p.maxPixelRatio).toBe(1.5);
    expect(p.targetFps).toBe(30);
  });
});

import { describeGpu, gpuLabel } from './perf';

describe('describeGpu', () => {
  it('reports WebGL2 as GPU-accelerated', () => {
    const g = describeGpu('apple m2', true, true, false);
    expect(g.backend).toBe('webgl2');
    expect(g.accelerated).toBe(true);
    expect(g.mlProvider).toBe('wasm');
  });
  it('reports WebGPU availability and picks it for ML', () => {
    const g = describeGpu('apple m2', true, true, true);
    expect(g.webgpu).toBe(true);
    expect(g.mlProvider).toBe('webgpu');
    expect(gpuLabel(g)).toMatch(/WebGPU/);
  });
  it('flags a software rasteriser as NOT accelerated', () => {
    const g = describeGpu('google swiftshader', true, true, false);
    expect(g.backend).toBe('software');
    expect(g.accelerated).toBe(false);
    expect(gpuLabel(g)).toMatch(/Software/);
  });
  it('handles no-GL devices', () => {
    const g = describeGpu('', false, false, false);
    expect(g.backend).toBe('none');
    expect(g.accelerated).toBe(false);
  });
});
