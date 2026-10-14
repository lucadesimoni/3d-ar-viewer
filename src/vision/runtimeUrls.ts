/**
 * Where the app's heavy runtimes come from: its own origin.
 *
 * OpenCV.js (10 MB), the Draco glTF decoder and ONNX Runtime's wasm were
 * fetched from docs.opencv.org and cdn.jsdelivr.net. A company network that
 * blocks CDNs, which the networks this is used on do, then quietly lost
 * recognition and compressed models; nothing third-party was cached for
 * offline use; and every visitor's address went to two outside hosts. Imported
 * as `?url`, each file is a fingerprinted asset of this build instead: served
 * with the app, cached by its service worker, at exactly the tested version.
 *
 * The Mendix widget has no origin of its own to serve them from, so its build
 * swaps this module for `runtimeUrls.cdn.ts` (see `vite.widget.config.ts`).
 */
import openCvUrl from '@techstark/opencv-js/dist/opencv.js?url';
import dracoWrapperUrl from 'draco3dgltf/draco_decoder_gltf_nodejs.js?url';
import dracoWasmUrl from 'draco3dgltf/draco_decoder_gltf.wasm?url';
import presenceModelUrl from '../perception/models/presence-v1.onnx?url';
import presenceModelInfo from '../perception/models/presence-v1.onnx.json';
import type { PresenceModelInfo } from '../perception/presenceModel';

export interface RuntimeUrls {
  openCv: string;
  /** ONNX Runtime's wasm folder; undefined uses the copy bundled with the app. */
  ortWasmPaths?: string;
  draco: { wasmUrl: string; wasmBinaryUrl: string };
  /** The trained presence model and its vote thresholds (`docs/PRESENCE_MODEL.md`). */
  presenceModel?: { url: string; info: PresenceModelInfo };
}

export const RUNTIME_URLS: RuntimeUrls = {
  openCv: openCvUrl,
  // ORT resolves its wasm next to its own bundle (`new URL(…, import.meta.url)`),
  // which the app build already emits as an asset.
  ortWasmPaths: undefined,
  draco: { wasmUrl: dracoWrapperUrl, wasmBinaryUrl: dracoWasmUrl },
  // 147 KB, loaded only once an assembly with a recognition target is in AR.
  presenceModel: import.meta.env.VITE_PRESENCE_MODEL === 'off'
    ? undefined
    : { url: presenceModelUrl, info: presenceModelInfo },
};
