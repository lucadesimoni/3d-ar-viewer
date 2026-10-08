import { describe, expect, it } from 'vitest';
import { toGray } from './imageOps';
import { detectGridFacade } from './gridRecognition';
import { renderShelf } from './testing/renderShelf';

const frame = () => renderShelf({ width: 640, height: 480, left: 160, top: 60, span: 320 });

describe('one camera frame, many readers', () => {
  it('is converted to grey once per downsampling step, not once per reader', () => {
    // The app's frames are 480px wide, which the detector (240) and the
    // tracker (320) both halve: the same image, so the same result.
    const image = renderShelf({ width: 480, height: 360, left: 120, top: 45, span: 240 });
    const a = toGray(image, 240);
    expect(toGray(image, 240)).toBe(a);
    expect(toGray(image, 320)).toBe(a);
    expect(toGray(image, 120)).not.toBe(a);
  });

  it('and a new frame is converted afresh', () => {
    const a = toGray(frame(), 240);
    const b = toGray(frame(), 240);
    expect(b).not.toBe(a);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });
});

describe('a lattice with the wrong number of bays', () => {
  it('is not refined — refinement moves lines, it cannot make it the target', () => {
    const image = frame();
    const right = detectGridFacade(image)!;
    expect(right.grid, 'refined when there is no target to rule it out').toBeDefined();
    const wrong = detectGridFacade(image, { target: { cols: right.cols + 1, rows: right.rows } });
    expect(wrong?.grid).toBeUndefined();
    const matching = detectGridFacade(image, { target: { cols: right.cols, rows: right.rows } });
    expect(matching?.grid, 'the target itself is refined as before').toBeDefined();
  });
});
