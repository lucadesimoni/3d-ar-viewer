import { Engine } from '@babylonjs/core/Engines/engine';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';

/**
 * Create the render engine: WebGL2 by default, WebGPU on request.
 *
 * WebGPU gives lower CPU overhead and better throughput on heavy scenes, and
 * this used to prefer it wherever it was supported. It is no longer the
 * default, for a reason worth writing down: the scene here is a few dozen
 * low-poly meshes and gains nothing measurable from WebGPU, while every check
 * in this repository runs on WebGL — a headless Chromium in a sandbox cannot
 * create a WebGPU context, so the WebGPU path was shipped to phones and
 * tablets having never once been executed by the test suite. An untested
 * renderer on the devices that matter is a bad trade for throughput nobody
 * needs. `?gpu=webgpu` opts back in, and still falls back to WebGL if
 * anything about the initialisation fails.
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

  if (forced === 'webgpu') {
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
