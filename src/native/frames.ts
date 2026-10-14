import type { NativeBridge, NativeCameraImage } from './bridge';

/**
 * One camera frame from the native shell, as pixels at most `maxWidth` wide:
 * what the recognition loop reads in the browser from a `<video>` or a WebXR
 * camera texture. Undefined if none comes within `timeoutMs`.
 */
export function requestCameraImage(
  bridge: NativeBridge,
  maxWidth: number,
  timeoutMs = 2000,
): Promise<{ image: ImageData; message: NativeCameraImage } | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { image: ImageData; message: NativeCameraImage } | undefined) => {
      if (done) return;
      done = true; clearTimeout(timer); unsubscribe(); resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const unsubscribe = bridge.subscribe((m) => {
      if (m.type !== 'camera-image') return;
      void decode(m.image, maxWidth).then((image) => finish(image ? { image, message: m } : undefined));
    });
    bridge.send({ type: 'request-image', maxWidth });
  });
}

async function decode(dataUrl: string, maxWidth: number): Promise<ImageData | undefined> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return undefined;
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return g.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return undefined;
  }
}
