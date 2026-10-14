import { describe, expect, it } from 'vitest';
import { combineVotes, modelVote, PresenceModel } from './presenceModel';

const t = { present: 0.8, absent: 0.2 };

describe('the presence model\'s vote', () => {
  it('votes only outside the thresholds, and abstains between', () => {
    expect(modelVote(0.9, t)).toEqual({ present: true });
    expect(modelVote(0.8, t)).toEqual({ present: true });
    expect(modelVote(0.1, t)).toEqual({ present: false });
    expect(modelVote(0.5, t)).toBeUndefined();
    expect(modelVote(Number.NaN, t)).toBeUndefined();
  });

  it('counts with the edge check when they agree or one is silent, and not when they contradict', () => {
    const yes = { present: true }; const no = { present: false };
    expect(combineVotes(yes, yes)).toEqual(yes);
    expect(combineVotes(yes, undefined)).toEqual(yes);
    expect(combineVotes(undefined, no)).toEqual(no);
    expect(combineVotes(yes, no)).toBeUndefined();
    expect(combineVotes(no, yes)).toBeUndefined();
    expect(combineVotes(undefined, undefined)).toBeUndefined();
  });

  it('refuses thresholds that would vote both ways at once', async () => {
    const model = new PresenceModel('/m.onnx', { thresholds: { present: 0.3, absent: 0.6 } });
    expect(await model.load()).toBe(false);
    expect(model.error).toMatch(/inverted/);
    expect(model.ready).toBe(false);
  });
});
