/**
 * OpenCV.js preprocessing for the recognition pipeline.
 *
 * The camera frame that reaches a neural net decides everything downstream, and
 * a raw tablet frame is a poor input: it is skewed by viewing angle, unevenly
 * lit by shop lighting, and often motion-blurred. This module does the classical
 * CV that makes the ML tractable — crop to the region of interest, correct the
 * perspective so a part is seen face-on, reject frames too blurred to trust, and
 * flatten the illumination so a model trained under lab light still fires under
 * a fluorescent tube.
 *
 * OpenCV.js is a ~8 MB WASM blob, so it is loaded lazily from a configurable URL
 * and every entry point degrades gracefully when it is absent: sharpness and
 * illumination have pure-canvas fallbacks, and the geometric ops simply report
 * unavailable rather than throwing.
 */

/** The sliver of the OpenCV.js API this module actually uses. */
interface CvMat {
  delete(): void;
  rows: number;
  cols: number;
  data32F: Float32Array;
  doublePtr(i: number, j: number): Float64Array;
}
interface CvModule {
  Mat: {
    new (): CvMat;
    new (rows: number, cols: number, type: number): CvMat;
  };
  matFromImageData(data: ImageData): CvMat;
  matFromArray(rows: number, cols: number, type: number, arr: number[]): CvMat;
  cvtColor(src: CvMat, dst: CvMat, code: number): void;
  Laplacian(src: CvMat, dst: CvMat, ddepth: number): void;
  meanStdDev(src: CvMat, mean: CvMat, std: CvMat): void;
  getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat;
  warpPerspective(src: CvMat, dst: CvMat, M: CvMat, size: { width: number; height: number }): void;
  GaussianBlur(src: CvMat, dst: CvMat, size: unknown, sigmaX: number): void;
  divide(a: CvMat, b: CvMat, dst: CvMat, scale: number): void;
  Size: new (w: number, h: number) => unknown;
  CV_8UC1: number;
  CV_8UC4: number;
  CV_32FC1: number;
  CV_64FC1: number;
  CV_32F: number;
  COLOR_RGBA2GRAY: number;
}

declare global {
  interface Window {
    cv?: CvModule | Promise<CvModule>;
  }
}

export interface Point2 {
  x: number;
  y: number;
}

export const DEFAULT_OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';

let loadPromise: Promise<CvModule | undefined> | undefined;

/**
 * Load OpenCV.js once and resolve when its runtime is actually initialised.
 *
 * OpenCV.js signals readiness in two different ways depending on build (a
 * `cv` promise, or an `onRuntimeInitialized` callback on the module object), so
 * both are handled. Returns `undefined` rather than throwing when the network or
 * the environment cannot provide it — callers are expected to cope.
 */
export function loadOpenCV(url: string = DEFAULT_OPENCV_URL): Promise<CvModule | undefined> {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<CvModule | undefined>((resolve) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      resolve(undefined);
      return;
    }
    const existing = window.cv;
    if (existing && !(existing instanceof Promise) && 'Mat' in existing) {
      resolve(existing);
      return;
    }

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = async () => {
      try {
        const cv = window.cv;
        if (cv instanceof Promise) {
          resolve(await cv);
        } else if (cv && 'Mat' in cv) {
          resolve(cv);
        } else {
          // Older builds expose a module that fires a callback when ready.
          const mod = cv as unknown as { onRuntimeInitialized?: () => void };
          if (mod) mod.onRuntimeInitialized = () => resolve(window.cv as CvModule);
          else resolve(undefined);
        }
      } catch {
        resolve(undefined);
      }
    };
    script.onerror = () => resolve(undefined);
    document.head.appendChild(script);
  });
  return loadPromise;
}

export const isOpenCVReady = (): boolean => {
  const cv = typeof window !== 'undefined' ? window.cv : undefined;
  return Boolean(cv && !(cv instanceof Promise) && 'Mat' in cv);
};

function getCv(): CvModule | undefined {
  const cv = typeof window !== 'undefined' ? window.cv : undefined;
  return cv && !(cv instanceof Promise) && 'Mat' in cv ? cv : undefined;
}

/** Draw any frame source into a canvas and return its ImageData. */
export function toImageData(
  source: CanvasImageSource,
  width: number,
  height: number,
): ImageData | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

export interface SharpnessResult {
  /** Variance of the Laplacian — the standard focus/blur metric. */
  variance: number;
  /** True when the frame is sharp enough to run detection on. */
  sharp: boolean;
}

/**
 * Blur rejection by variance of the Laplacian.
 *
 * Running a detector on a motion-blurred frame wastes a whole inference and,
 * worse, produces confident-looking garbage boxes. Gating on focus first is the
 * cheapest reliability win in the pipeline. Uses OpenCV when present, and a
 * plain-JS Laplacian on the luma channel when it is not.
 */
export function measureSharpness(image: ImageData, threshold = 100): SharpnessResult {
  const cv = getCv();
  if (cv) {
    const src = cv.matFromImageData(image);
    const gray = new cv.Mat();
    const lap = new cv.Mat();
    const mean = new cv.Mat();
    const std = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.Laplacian(gray, lap, cv.CV_64FC1);
      cv.meanStdDev(lap, mean, std);
      const sd = std.doublePtr(0, 0)[0];
      const variance = sd * sd;
      return { variance, sharp: variance >= threshold };
    } finally {
      src.delete();
      gray.delete();
      lap.delete();
      mean.delete();
      std.delete();
    }
  }
  const variance = laplacianVarianceJS(image);
  return { variance, sharp: variance >= threshold };
}

/** Fallback 3x3 Laplacian variance on luma, no dependencies. */
function laplacianVarianceJS(image: ImageData): number {
  const { data, width, height } = image;
  const luma = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap =
        4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Warp a quadrilateral region of the frame to a rectangle, seen face-on.
 *
 * Feed it the four corners of a part or a marker (in the order TL, TR, BR, BL)
 * and it returns an `ImageData` of the requested output size with the
 * perspective removed — exactly the canonical view a classifier wants. Requires
 * OpenCV; returns `undefined` otherwise.
 */
export function perspectiveCorrect(
  image: ImageData,
  corners: [Point2, Point2, Point2, Point2],
  outWidth: number,
  outHeight: number,
): ImageData | undefined {
  const cv = getCv();
  if (!cv) return undefined;

  const src = cv.matFromImageData(image);
  const dst = new cv.Mat();
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC1 + 8 /* CV_32FC2 */, [
    corners[0].x, corners[0].y,
    corners[1].x, corners[1].y,
    corners[2].x, corners[2].y,
    corners[3].x, corners[3].y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC1 + 8, [
    0, 0, outWidth, 0, outWidth, outHeight, 0, outHeight,
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(outWidth, outHeight) as { width: number; height: number });
    return matToImageData(dst, outWidth, outHeight);
  } finally {
    src.delete();
    dst.delete();
    srcTri.delete();
    dstTri.delete();
    M.delete();
  }
}

function matToImageData(mat: CvMat, width: number, height: number): ImageData | undefined {
  // OpenCV.js stores the pixel bytes on `mat.data`; typed as unknown here to keep
  // the facade minimal. Guard defensively since builds differ.
  const raw = (mat as unknown as { data?: ArrayLike<number> }).data;
  if (!raw) return undefined;
  // Copy into a fresh, non-shared buffer so the result is a standalone ImageData.
  const copy = new Uint8ClampedArray(width * height * 4);
  copy.set(raw as ArrayLike<number>);
  return new ImageData(copy, width, height);
}

/** Crop an axis-aligned region, clamped to the frame. */
export function crop(image: ImageData, x: number, y: number, w: number, h: number): ImageData {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(image.width, Math.floor(x + w));
  const y1 = Math.min(image.height, Math.floor(y + h));
  const cw = Math.max(1, x1 - x0);
  const ch = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcStart = ((y0 + row) * image.width + x0) * 4;
    out.set(image.data.subarray(srcStart, srcStart + cw * 4), row * cw * 4);
  }
  return new ImageData(out, cw, ch);
}

/**
 * Illumination normalization by homomorphic-style division.
 *
 * The low-frequency component of an image is (mostly) the lighting; dividing the
 * frame by a heavily blurred copy of itself flattens gradients and vignetting so
 * a part looks the same under a window as under a lamp. OpenCV path uses a real
 * Gaussian; the fallback uses a separable box blur, which is coarser but keeps
 * the pipeline working with no WASM.
 */
export function normalizeIllumination(image: ImageData, sigma = 25): ImageData {
  const cv = getCv();
  if (cv) {
    const src = cv.matFromImageData(image);
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const norm = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(0, 0), sigma);
      cv.divide(gray, blur, norm, 128);
      const out = matToImageData(norm, image.width, image.height);
      if (out) return out;
    } finally {
      src.delete();
      gray.delete();
      blur.delete();
      norm.delete();
    }
  }
  return normalizeIlluminationJS(image, Math.round(sigma));
}

function normalizeIlluminationJS(image: ImageData, radius: number): ImageData {
  const { data, width, height } = image;
  const luma = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    luma[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const blurred = boxBlur(luma, width, height, Math.max(1, radius));
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < width * height; i++) {
    const denom = blurred[i] < 1 ? 1 : blurred[i];
    const v = Math.max(0, Math.min(255, (luma[i] / denom) * 128));
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, width, height);
}

/** Separable box blur, used only by the no-WASM illumination fallback. */
function boxBlur(src: Float64Array, width: number, height: number, radius: number): Float64Array {
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  const win = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += src[y * width + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      tmp[y * width + x] = acc / win;
      const add = src[y * width + Math.min(width - 1, x + radius + 1)];
      const sub = src[y * width + Math.max(0, x - radius)];
      acc += add - sub;
    }
  }
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = acc / win;
      const add = tmp[Math.min(height - 1, y + radius + 1) * width + x];
      const sub = tmp[Math.max(0, y - radius) * width + x];
      acc += add - sub;
    }
  }
  return out;
}
