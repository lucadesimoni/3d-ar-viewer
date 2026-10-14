/** In the browser: decode a report's frame and cut the presence model's crops from it, as the app would. */
import { cropToRgba, presenceCrop } from '../../src/perception/presenceInput';

async function crops(src: string, outlines: number[][]): Promise<(string | null)[]> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const image = g.getImageData(0, 0, canvas.width, canvas.height);
  return outlines.map((flat) => {
    const hull = [];
    for (let i = 0; i + 1 < flat.length; i += 2) hull.push({ x: flat[i], y: flat[i + 1] });
    const crop = presenceCrop(image, hull);
    if (!crop) return null;
    const bytes = cropToRgba(crop);
    let s = ''; for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    return btoa(s);
  });
}

(window as unknown as { reportCrops: typeof crops }).reportCrops = crops;
