import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Vector3 as BVector3 } from '@babylonjs/core/Maths/math.vector';
import { toFrameImage } from './cameraFrame';
import { cameraIntrinsics } from '../../perception/intrinsics';
import { roiForObb } from '../../perception/roi';

const W = 160;
const H = 240;
const FOV_DEG = 72.18;

/** An RGBA buffer, all black, with a writer that takes image-space rows. */
function frame(w: number, h: number) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return {
    px,
    /** Write a bright block, counting rows the way an *image* does: top-down. */
    blockTopDown(x0: number, y0: number, x1: number, y1: number, value = 255): void {
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
          const i = (y * w + x) * 4;
          px[i] = value; px[i + 1] = value; px[i + 2] = value;
        }
      }
    },
    /** The same, counting rows the way *WebGL* hands a framebuffer back. */
    blockBottomUp(x0: number, y0: number, x1: number, y1: number, value = 255): void {
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
          const i = ((h - 1 - y) * w + x) * 4;
          px[i] = value; px[i + 1] = value; px[i + 2] = value;
        }
      }
    },
  };
}

/** Mean luminance of one row of the produced image. */
const rowMean = (img: ImageData, y: number): number => {
  let sum = 0;
  for (let x = 0; x < img.width; x++) sum += img.data[(y * img.width + x) * 4];
  return sum / img.width;
};

describe('the camera image, the right way up', () => {
  it('lands where the geometry says it should — the whole point of the flip', () => {
    // The check the plan called for, and the reason it is not a guess: a
    // texture stored bottom-up, righted, must put a bright block exactly in
    // the rectangle `roiForObb` predicts for the same object. Two paths that
    // share no code — Babylon's view matrix and a hand-written row flip —
    // agreeing on which end of the image is the sky. Drop the flip and this
    // block lands in the mirror-image rows, which on a device looks like a
    // detector that cannot find a part in plain view.
    const engine = new NullEngine({
      renderWidth: W, renderHeight: H, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    const camera = new UniversalCamera('cam', new BVector3(0, 0, 0), scene);
    camera.fov = (FOV_DEG * Math.PI) / 180;
    camera.minZ = 0.05;
    scene.activeCamera = camera;
    camera.setTarget(new BVector3(0, 0, 1));
    scene.updateTransformMatrix();

    const k = cameraIntrinsics({ frame: { width: W, height: H }, xrFovDeg: FOV_DEG });
    // Above the camera's line of sight: higher in the world is a *smaller*
    // row number in an image.
    const roi = roiForObb({
      center: new Vector3(0, 0.5, 2),
      halfExtents: new Vector3(0.15, 0.15, 0.15),
      rotation: new Quaternion(),
    }, scene.getViewMatrix().asArray(), k)!;
    expect(roi.rect.y + roi.rect.h).toBeLessThan(H / 2);

    const src = frame(W, H);
    src.blockBottomUp(
      Math.round(roi.rect.x), Math.round(roi.rect.y),
      Math.round(roi.rect.x + roi.rect.w), Math.round(roi.rect.y + roi.rect.h),
    );
    const image = toFrameImage(src.px, { width: W, height: H }, W, true)!;

    const inside = rowMean(image, Math.round(roi.rect.y + roi.rect.h / 2));
    const mirrored = rowMean(image, H - 1 - Math.round(roi.rect.y + roi.rect.h / 2));
    expect(inside).toBeGreaterThan(10);
    expect(mirrored).toBe(0);
    engine.dispose();
  });

  it('leaves a top-down texture alone when the renderer says it is already right', () => {
    const src = frame(W, H);
    src.blockTopDown(0, 0, W, 10);
    const image = toFrameImage(src.px, { width: W, height: H }, W, false)!;
    expect(rowMean(image, 2)).toBe(255);
    expect(rowMean(image, H - 3)).toBe(0);
  });

  it('rights the rows on the scaled path too, not just the full-size one', () => {
    // Two paths now: a full-size frame is a row copy, a reduced one goes
    // through the box filter. Each has its own flip, so each needs its own
    // check — a test that only ever exercises one of them would let the other
    // ship upside down.
    const src = frame(W, H);
    src.blockBottomUp(0, 0, W, 40);     // stored at the bottom, belongs on top
    const scaled = toFrameImage(src.px, { width: W, height: H }, W / 4, true)!;
    expect(scaled.width).toBe(W / 4);
    expect(rowMean(scaled, 2)).toBe(255);
    expect(rowMean(scaled, scaled.height - 3)).toBe(0);
  });
});

describe('scaling down to the working size', () => {
  it('averages the pixels it drops instead of picking one', () => {
    // 886 to 480 is a factor of 1.85. Dropping every other row of a shelf full
    // of straight edges is how a lattice fit starts seeing spacings that are
    // not there, so a half-covered destination pixel must come out half-bright
    // rather than black or white.
    const src = frame(4, 4);
    src.blockTopDown(0, 0, 4, 2);          // top half white, bottom half black
    const image = toFrameImage(src.px, { width: 4, height: 4 }, 2, false)!;
    expect([image.width, image.height]).toEqual([2, 2]);
    expect(rowMean(image, 0)).toBe(255);
    expect(rowMean(image, 1)).toBe(0);

    // And a checkerboard, where every destination pixel straddles both.
    const checks = frame(4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      if ((x + y) % 2 === 0) checks.blockTopDown(x, y, x + 1, y + 1);
    }
    const half = toFrameImage(checks.px, { width: 4, height: 4 }, 2, false)!;
    // Mid-grey, not black and not white: nearest-neighbour would return one
    // of the two originals for every pixel.
    for (let i = 0; i < 4; i++) {
      expect(half.data[i * 4]).toBeGreaterThan(120);
      expect(half.data[i * 4]).toBeLessThan(136);
    }
  });

  it('keeps the aspect ratio, and never scales up', () => {
    const src = frame(886, 60);
    const image = toFrameImage(src.px, { width: 886, height: 60 }, 480, false)!;
    expect(image.width).toBe(480);
    expect(image.height).toBe(Math.round(60 * (480 / 886)));

    const small = frame(100, 50);
    const kept = toFrameImage(small.px, { width: 100, height: 50 }, 480, false)!;
    expect([kept.width, kept.height]).toEqual([100, 50]);
  });

  it('forces the alpha opaque', () => {
    // A camera texture whose alpha channel was never written reads as zero,
    // and every later `putImageData` of it would draw nothing at all.
    const px = new Uint8Array(4 * 4 * 4);
    px.fill(120);
    for (let i = 3; i < px.length; i += 4) px[i] = 0;
    // Both paths: the row copy carries the source alpha across, the box filter
    // never reads it at all.
    for (const maxWidth of [4, 2]) {
      const image = toFrameImage(px, { width: 4, height: 4 }, maxWidth, false)!;
      for (let i = 3; i < image.data.length; i += 4) expect(image.data[i]).toBe(255);
    }
  });

  it('answers nothing rather than guessing, when there is nothing to answer with', () => {
    const px = new Uint8Array(16);
    expect(toFrameImage(px, { width: 0, height: 4 }, 4, false)).toBeUndefined();
    expect(toFrameImage(px, { width: 4, height: 4 }, 0, false)).toBeUndefined();
    // A buffer too short for the size it claims: a truncated readback.
    expect(toFrameImage(px, { width: 40, height: 40 }, 4, false)).toBeUndefined();
  });
});
