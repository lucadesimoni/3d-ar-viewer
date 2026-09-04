import { Engine } from '@babylonjs/core/Engines/engine';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';

/**
 * Create the best available render engine: WebGPU when the device and browser
 * support it, otherwise WebGL2.
 *
 * WebGPU (Safari 26+, modern Chrome/Edge/Android) gives lower CPU overhead and
 * better throughput on heavy scenes than WebGL. It is not universal, so this
 * probes support and initialises it asynchronously, and *any* failure —
 * unsupported device, a blocked WGSL transpiler fetch, an init error — falls
 * straight back to the WebGL2 engine that works everywhere. The caller gets a
 * ready engine and a tag saying which backend it got.
 *
 * `?gpu=webgl` forces the WebGL path (debugging); `?gpu=webgpu` still only uses
 * WebGPU when actually supported.
 */
export type RenderBackendKind = 'webgpu' | 'webgl';

export interface CreatedEngine {
  engine: AbstractEngine;
  kind: RenderBackendKind;
}

export async function createBestEngine(
  canvas: HTMLCanvasElement,
  opts: { antialias: boolean },
  search = '',
): Promise<CreatedEngine> {
  const forced = new URLSearchParams(search).get('gpu');
  const preferWebGPU = forced !== 'webgl';

  if (preferWebGPU) {
    const webgpu = await tryWebGPU(canvas, opts).catch(() => undefined);
    if (webgpu) return { engine: webgpu, kind: 'webgpu' };
  }

  const engine = new Engine(canvas, opts.antialias, {
    preserveDrawingBuffer: true,
    stencil: true,
    antialias: opts.antialias,
    powerPreference: 'high-performance',
    adaptToDeviceRatio: true,
  });
  return { engine, kind: 'webgl' };
}

async function tryWebGPU(
  canvas: HTMLCanvasElement,
  opts: { antialias: boolean },
): Promise<AbstractEngine | undefined> {
  const { WebGPUEngine } = await import('@babylonjs/core/Engines/webgpuEngine');
  const supported = await WebGPUEngine.IsSupportedAsync;
  if (!supported) return undefined;
  const engine = new WebGPUEngine(canvas, {
    antialias: opts.antialias,
    powerPreference: 'high-performance',
    stencil: true,
  });
  await engine.initAsync(); // loads the WGSL transpiler; throws → caller falls back
  return engine;
}
