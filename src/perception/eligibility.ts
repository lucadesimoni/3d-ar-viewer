import type { PartRoi } from './roi';

/**
 * Whether asking the image about a part right now is a fair question.
 *
 * The one rule this module must never break: "I cannot see it" must never
 * become "it is not there." A blurry frame, a part behind another, or the
 * exploded view pulling everything apart are all reasons the question has no
 * honest answer — not reasons to answer "absent." This function only says
 * whether asking is fair, and why not when it is not; it never itself says
 * present or absent.
 *
 * Every gate that fails is collected, not just the first — a diagnostics log
 * showing only "ineligible" for an entire session, with no reason, is as
 * useless as the false lock this whole effort started from.
 */

export type EligibilityReason =
  | 'no-target'
  | 'no-anchor'
  | 'clipped'
  | 'too-small'
  | 'too-far'
  | 'blurry'
  | 'not-settled'
  | 'exploded'
  | 'occluded'
  | 'blank-frame';

export interface EligibilityInput {
  /** The assembly has a `recognition` target at all — see the KALLAX-only note above. */
  hasTarget: boolean;
  /** The AR session has committed to a placement. */
  anchored: boolean;
  /** From `roiForObb`/`roiForBox` — `undefined` counts the same as `clipped`. */
  roi: PartRoi | undefined;
  /** From `measureSharpness(image, 90).sharp` — the threshold `pipeline.ts` actually runs. */
  sharp: boolean;
  /** `store.arTracking?.ready` — placement is still just a guess otherwise. */
  trackingReady: boolean;
  /** `store.explodeFactor` — the same field `SceneManager` itself gates rendering on. */
  explodeFactor: number;
  /** Whether something else in the scene sits between the camera and this part. */
  occluded: boolean;
  /** `render.frameUniform` — a blank frame proves nothing, one way or the other. */
  frameUniform: boolean;
}

export interface EligibilityOptions {
  /** Share of the frame the ROI must fill. */
  minAreaFraction?: number;
  /**
   * Metres, beyond which a part is asked about at a distance nobody has
   * measured a real answer for. Deliberately generous, not measured: there is
   * no device session yet to calibrate it against, and the `AGREEMENT_M`
   * lesson (0.15 m looked more careful than 0.2 m and instead made real locks
   * impossible) says a guessed *tight* threshold is worse than a guessed
   * loose one. Tighten only once a real session shows where it should sit.
   */
  maxDistanceM?: number;
}

export interface Eligibility {
  eligible: boolean;
  reasons: EligibilityReason[];
}

const DEFAULT_MIN_AREA_FRACTION = 0.01;
const DEFAULT_MAX_DISTANCE_M = 2.5;

export function checkEligibility(
  input: EligibilityInput,
  opts: EligibilityOptions = {},
): Eligibility {
  const minAreaFraction = opts.minAreaFraction ?? DEFAULT_MIN_AREA_FRACTION;
  const maxDistanceM = opts.maxDistanceM ?? DEFAULT_MAX_DISTANCE_M;

  const reasons: EligibilityReason[] = [];
  if (!input.hasTarget) reasons.push('no-target');
  if (!input.anchored) reasons.push('no-anchor');
  if (!input.roi || input.roi.clipped) reasons.push('clipped');
  if (input.roi && input.roi.areaFraction < minAreaFraction) reasons.push('too-small');
  if (input.roi && input.roi.distanceM > maxDistanceM) reasons.push('too-far');
  if (!input.sharp) reasons.push('blurry');
  if (!input.trackingReady) reasons.push('not-settled');
  if (input.explodeFactor > 0) reasons.push('exploded');
  if (input.occluded) reasons.push('occluded');
  // A blank frame proves nothing about the part either way, whatever the
  // other gates say — added alongside them, since `eligible` is false the
  // moment any reason is present, this one included.
  if (input.frameUniform) reasons.push('blank-frame');

  return { eligible: reasons.length === 0, reasons };
}
