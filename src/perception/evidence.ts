/**
 * Presence over time, with hysteresis — the same shape as `DetectionTracker`'s
 * `hits`/`misses`/`confirmed` counters (`vision/tracking.ts`), not a ring
 * buffer. No single frame decides: a part flips to `'present'` only after
 * several consecutive eligible observations agree, and back to `'absent'`
 * only after several consecutive eligible observations agree it is gone.
 *
 * The one rule this exists to protect: an observation the eligibility check
 * rejected touches neither counter. A part that was confirmed present and is
 * then briefly blurry, occluded, or viewed during an exploded frame must stay
 * `'present'` — that observation was never made, not a vote for `'absent'`.
 */

export type PresenceState = 'present' | 'absent' | 'unknown';

export interface EvidenceState {
  presentHits: number;
  absentHits: number;
  state: PresenceState;
}

export interface EvidenceOptions {
  /** Consecutive agreeing observations needed to commit either way. */
  minHits?: number;
}

const DEFAULT_MIN_HITS = 3;

export function initEvidence(): EvidenceState {
  return { presentHits: 0, absentHits: 0, state: 'unknown' };
}

/**
 * Folds one observation into the running evidence.
 *
 * `observation` is `undefined` for an ineligible frame — the eligibility
 * check said asking was not fair, so this call is a no-op: both counters and
 * `state` come back unchanged.
 */
export function foldEvidence(
  state: EvidenceState,
  observation: { present: boolean } | undefined,
  opts: EvidenceOptions = {},
): EvidenceState {
  if (!observation) return state;
  const minHits = opts.minHits ?? DEFAULT_MIN_HITS;

  const presentHits = observation.present ? state.presentHits + 1 : 0;
  const absentHits = observation.present ? 0 : state.absentHits + 1;

  // A single contradicting observation resets the *other* counter to zero,
  // but must not itself erase an already-committed state — that takes
  // `minHits` contradicting observations in a row, same as reaching it the
  // first time. Until then, whatever was true a moment ago is still true.
  let next = state.state;
  if (presentHits >= minHits) next = 'present';
  else if (absentHits >= minHits) next = 'absent';

  return { presentHits, absentHits, state: next };
}
