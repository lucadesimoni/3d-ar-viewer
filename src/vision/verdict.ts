import type { Track } from './tracking';

/**
 * Turn recognition output into a colour-coded discrepancy verdict.
 *
 * Recognising a part is only useful if the operator is told whether it is the
 * *right* part for what they are doing now. This compares each confirmed track's
 * label against the parts the active step expects and against the full parts
 * list, and assigns a status that drives the overlay colour:
 *
 *   match     → green   the expected part is in view
 *   mismatch  → red     a different, known part is in view (wrong pick)
 *   unknown   → amber   something detected that maps to no known part
 *
 * The wrong-part case is the high-value one: catching it from the camera, before
 * the operator even tries to seat it, is earlier than any geometric fit check.
 */

export type RecognitionStatus = 'match' | 'mismatch' | 'unknown';
export type OverallVerdict = 'correct' | 'wrong' | 'searching';

export interface RecognizedObject {
  id: number;
  label: string;
  /** Human-readable part name when the label maps to a known part. */
  name?: string;
  score: number;
  /** Normalised box (0..1) in the camera frame. */
  box: { x: number; y: number; w: number; h: number };
  status: RecognitionStatus;
}

export interface RecognitionState {
  objects: RecognizedObject[];
  verdict: OverallVerdict;
  /** Part labels the active step is expecting. */
  expectedLabels: string[];
  /** Strongest wrong part in view, if any. */
  wrongLabel?: string;
  wrongName?: string;
  ts: number;
}

export interface LabelInfo {
  /** All recognisable part labels → display name. */
  known: Map<string, string>;
  /** Labels the active step expects. */
  expected: Set<string>;
}

/**
 * Classify confirmed tracks against what the step expects.
 *
 * Only confirmed tracks should be passed in (the tracker already gates on
 * min-hits) so a one-frame flicker never flips the overlay to a red alert.
 */
export function classifyRecognition(
  tracks: Track[],
  info: LabelInfo,
  now = Date.now(),
): RecognitionState {
  const objects: RecognizedObject[] = tracks.map((t) => {
    const isExpected = info.expected.has(t.label);
    const isKnown = info.known.has(t.label);
    const status: RecognitionStatus = isExpected ? 'match' : isKnown ? 'mismatch' : 'unknown';
    return {
      id: t.id,
      label: t.label,
      name: info.known.get(t.label),
      score: t.score,
      box: t.box,
      status,
    };
  });

  const mismatches = objects.filter((o) => o.status === 'mismatch').sort((a, b) => b.score - a.score);
  const hasMatch = objects.some((o) => o.status === 'match');

  let verdict: OverallVerdict;
  if (mismatches.length > 0) verdict = 'wrong';
  else if (hasMatch) verdict = 'correct';
  else verdict = 'searching';

  return {
    objects,
    verdict,
    expectedLabels: [...info.expected],
    wrongLabel: mismatches[0]?.label,
    wrongName: mismatches[0]?.name,
    ts: now,
  };
}

export const STATUS_COLORS: Record<RecognitionStatus, string> = {
  match: '#22c55e',
  mismatch: '#ef4444',
  unknown: '#f59e0b',
};

export const VERDICT_COLORS: Record<OverallVerdict, string> = {
  correct: '#22c55e',
  wrong: '#ef4444',
  searching: '#f59e0b',
};
