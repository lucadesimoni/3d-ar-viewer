import { Quaternion, Vector3 } from 'three';
import { polygonAgreement, type Agreement } from './agreement';
import { partContour } from './contour';
import { checkEligibility, type Eligibility, type EligibilityInput } from './eligibility';
import { roiForBox } from './roi';
import type { EdgeField } from './edges';
import type { CameraIntrinsics } from './intrinsics';

/**
 * One look at one part: is the real thing where the model says it should be?
 *
 * The chain the earlier Stage A modules were built for, in order: is it fair to
 * ask (`eligibility`), where should its silhouette be (`contour`), and does the
 * image have edges there (`agreement`). The answer is a vote for `evidence.ts`,
 * or no vote at all — never "absent" because the question could not be asked.
 *
 * **The vote thresholds are provisional.** The only measurement behind them is
 * one frame from a real session: the real KALLAX facade's outline found edges
 * at 63% of its samples, a wrong pose at 31%, and a side with nothing behind
 * it at 4%. So a part answers "present" at 50% or more, "absent" at 15% or
 * less, and in between it does not vote. Every reading is logged so a device
 * session can move these to where the data says they belong.
 */

export const PRESENT_MIN_COVERAGE = 0.5;
export const ABSENT_MAX_COVERAGE = 0.15;

export interface PartBox {
  center: readonly [number, number, number];
  halfExtents: readonly [number, number, number];
  rotation: readonly [number, number, number, number];
}

export interface PresenceInput {
  field: EdgeField;
  box: PartBox;
  viewMatrix: ArrayLike<number>;
  k: CameraIntrinsics;
  /** Every eligibility gate except the region, which is computed here. */
  gates: Omit<EligibilityInput, 'roi'>;
}

export interface PresenceReading {
  eligibility: Eligibility;
  agreement?: Agreement;
  /** Undefined means "no vote" — ineligible, or too ambiguous to call. */
  vote?: { present: boolean };
}

export function readPresence(input: PresenceInput): PresenceReading {
  const roi = roiForBox(input.box, input.viewMatrix, input.k);
  const eligibility = checkEligibility({ ...input.gates, roi });
  if (!eligibility.eligible) return { eligibility };

  const contour = partContour({
    center: new Vector3(...input.box.center),
    halfExtents: new Vector3(...input.box.halfExtents),
    rotation: new Quaternion(...input.box.rotation),
  }, input.viewMatrix, input.k);
  if (!contour || contour.hull.length < 3) return { eligibility };

  const agreement = polygonAgreement(input.field, contour.hull);
  const vote = agreement.coverage >= PRESENT_MIN_COVERAGE ? { present: true }
    : agreement.coverage <= ABSENT_MAX_COVERAGE ? { present: false }
      : undefined;
  return { eligibility, agreement, vote };
}
