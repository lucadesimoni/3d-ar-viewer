import { describe, expect, it } from 'vitest';
import { TAP_HOLD_MS, TAP_TRAVEL_PX, isTap } from './tap';

describe('what counts as a tap', () => {
  it('allows the wobble of a real hand', () => {
    expect(isTap({ travelPx: 0, heldMs: 40 })).toBe(true);
    expect(isTap({ travelPx: 3, heldMs: 120 })).toBe(true);
    expect(isTap({ travelPx: TAP_TRAVEL_PX, heldMs: TAP_HOLD_MS })).toBe(true);
  });

  it('refuses a swipe', () => {
    // The gesture that placed the assembly on Android and still did on iOS.
    expect(isTap({ travelPx: TAP_TRAVEL_PX + 1, heldMs: 50 })).toBe(false);
    expect(isTap({ travelPx: 196, heldMs: 50 })).toBe(false);
  });

  it('refuses a press', () => {
    expect(isTap({ travelPx: 2, heldMs: TAP_HOLD_MS + 1 })).toBe(false);
  });
});
