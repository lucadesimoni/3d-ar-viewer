import { describe, expect, it } from 'vitest';
import { sameTags, type Tag } from './RecognitionOverlay';

const tag = (x: number, status: Tag['status'] = 'match'): Tag => ({ id: 1, label: 'Shaft', status, score: 0.9, x, y: 40 });

describe('recognition tags, projected every frame', () => {
  it('a sub-pixel wobble is not a change worth a re-render', () => {
    expect(sameTags([tag(100.1)], [tag(100.3)])).toBe(true);
  });
  it('a move, a new verdict, or a tag coming or going is', () => {
    expect(sameTags([tag(100)], [tag(104)])).toBe(false);
    expect(sameTags([tag(100)], [tag(100, 'mismatch')])).toBe(false);
    expect(sameTags([tag(100)], [])).toBe(false);
  });
});
