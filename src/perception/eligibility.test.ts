import { describe, expect, it } from 'vitest';
import { checkEligibility, type EligibilityInput } from './eligibility';
import type { PartRoi } from './roi';

const goodRoi: PartRoi = { rect: { x: 10, y: 10, w: 100, h: 100 }, areaFraction: 0.2, distanceM: 1, clipped: false };

const good: EligibilityInput = {
  hasTarget: true,
  anchored: true,
  roi: goodRoi,
  sharp: true,
  trackingReady: true,
  explodeFactor: 0,
  occluded: false,
  frameUniform: false,
};

describe('whether asking the image is fair', () => {
  it('is eligible when every gate is clear', () => {
    const e = checkEligibility(good);
    expect(e.eligible).toBe(true);
    expect(e.reasons).toEqual([]);
  });

  it('names no-target when the assembly has nothing to recognise', () => {
    const e = checkEligibility({ ...good, hasTarget: false });
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(['no-target']);
  });

  it('names no-anchor before the session has committed to a placement', () => {
    const e = checkEligibility({ ...good, anchored: false });
    expect(e.reasons).toEqual(['no-anchor']);
  });

  it('names clipped when the ROI is missing entirely', () => {
    const e = checkEligibility({ ...good, roi: undefined });
    expect(e.reasons).toEqual(['clipped']);
  });

  it('names clipped when the ROI says so, without needing area or distance', () => {
    const e = checkEligibility({ ...good, roi: { ...goodRoi, clipped: true } });
    expect(e.reasons).toEqual(['clipped']);
  });

  it('names too-small below the area floor', () => {
    const e = checkEligibility({ ...good, roi: { ...goodRoi, areaFraction: 0.005 } });
    expect(e.reasons).toEqual(['too-small']);
  });

  it('names too-far beyond the distance ceiling', () => {
    const e = checkEligibility({ ...good, roi: { ...goodRoi, distanceM: 3 } });
    expect(e.reasons).toEqual(['too-far']);
  });

  it('names blurry when the frame fails the sharpness check', () => {
    const e = checkEligibility({ ...good, sharp: false });
    expect(e.reasons).toEqual(['blurry']);
  });

  it('names not-settled before tracking has settled', () => {
    const e = checkEligibility({ ...good, trackingReady: false });
    expect(e.reasons).toEqual(['not-settled']);
  });

  it('names exploded once the exploded view has pulled parts apart at all', () => {
    // Follows SceneManager's own convention: gated on the factor itself, not
    // on which view mode is nominally selected.
    const e = checkEligibility({ ...good, explodeFactor: 0.01 });
    expect(e.reasons).toEqual(['exploded']);
  });

  it('names occluded when the caller says something sits in front', () => {
    const e = checkEligibility({ ...good, occluded: true });
    expect(e.reasons).toEqual(['occluded']);
  });

  it('collects every failing gate at once, not just the first', () => {
    const e = checkEligibility({
      ...good,
      anchored: false,
      sharp: false,
      explodeFactor: 0.5,
    });
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(expect.arrayContaining(['no-anchor', 'blurry', 'exploded']));
    expect(e.reasons).toHaveLength(3);
  });

  it('forces ineligibility on a blank frame even when everything else passes', () => {
    const e = checkEligibility({ ...good, frameUniform: true });
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(['blank-frame']);
  });

  it('respects a custom area floor and distance ceiling', () => {
    const strict = checkEligibility(
      { ...good, roi: { ...goodRoi, areaFraction: 0.05, distanceM: 1.5 } },
      { minAreaFraction: 0.1, maxDistanceM: 1 },
    );
    expect(strict.reasons).toEqual(expect.arrayContaining(['too-small', 'too-far']));
  });
});
