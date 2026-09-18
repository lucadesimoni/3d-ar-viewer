import { describe, expect, it } from 'vitest';
import { foldEvidence, initEvidence, type EvidenceState } from './evidence';

function fold(state: EvidenceState, observations: ({ present: boolean } | undefined)[]): EvidenceState {
  return observations.reduce((s, o) => foldEvidence(s, o), state);
}

describe('presence evidence, with hysteresis', () => {
  it('starts unknown', () => {
    expect(initEvidence().state).toBe('unknown');
  });

  it('commits to present only after minHits consecutive present observations', () => {
    let s = initEvidence();
    s = foldEvidence(s, { present: true });
    expect(s.state).toBe('unknown');
    s = foldEvidence(s, { present: true });
    expect(s.state).toBe('unknown');
    s = foldEvidence(s, { present: true });
    expect(s.state).toBe('present');
  });

  it('commits to absent only after minHits consecutive absent observations', () => {
    const s = fold(initEvidence(), [{ present: false }, { present: false }, { present: false }]);
    expect(s.state).toBe('absent');
  });

  it('leaves the counters and the state untouched by an ineligible observation', () => {
    // This is the non-negotiable rule: "I did not look" must never move the
    // needle toward "it is not there," in either direction.
    const committed = fold(initEvidence(), [{ present: true }, { present: true }, { present: true }]);
    const afterSkip = foldEvidence(committed, undefined);
    expect(afterSkip).toEqual(committed);
  });

  it('does not flip to absent on a single contradicting observation after being present', () => {
    const committed = fold(initEvidence(), [{ present: true }, { present: true }, { present: true }]);
    const s = foldEvidence(committed, { present: false });
    expect(s.state, 'one contradicting frame is not enough to undo three agreeing ones').toBe('present');
    expect(s.absentHits).toBe(1);
  });

  it('flips from present to absent once the contradiction itself runs minHits long', () => {
    let s = fold(initEvidence(), [{ present: true }, { present: true }, { present: true }]);
    expect(s.state).toBe('present');
    s = fold(s, [{ present: false }, { present: false }, { present: false }]);
    expect(s.state).toBe('absent');
  });

  it('an ineligible observation in the middle of a committing run does not reset the count', () => {
    let s = initEvidence();
    s = foldEvidence(s, { present: true });
    s = foldEvidence(s, undefined);
    s = foldEvidence(s, { present: true });
    s = foldEvidence(s, { present: true });
    expect(s.state, 'the skipped frame did not cost the run its progress').toBe('present');
  });

  it('respects a custom minHits', () => {
    let s = initEvidence();
    s = foldEvidence(s, { present: true }, { minHits: 1 });
    expect(s.state).toBe('present');
  });
});
