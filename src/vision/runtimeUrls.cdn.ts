/**
 * The Mendix widget's runtimes: the same files and versions as the app's
 * (`runtimeUrls.ts`), from the CDN, since a widget has no origin of its own to
 * serve 40 MB of runtimes from.
 */
import type { RuntimeUrls } from './runtimeUrls';

const ORT_VERSION = '1.29.0';

export const RUNTIME_URLS: RuntimeUrls = {
  openCv: 'https://docs.opencv.org/4.10.0/opencv.js',
  ortWasmPaths: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`,
  draco: {
    wasmUrl: 'https://cdn.jsdelivr.net/npm/draco3dgltf@1.5.7/draco_decoder_gltf_nodejs.js',
    wasmBinaryUrl: 'https://cdn.jsdelivr.net/npm/draco3dgltf@1.5.7/draco_decoder_gltf.wasm',
  },
  // No presence model: it is not on a CDN, and the widget has nowhere to serve it from.
  presenceModel: undefined,
};
