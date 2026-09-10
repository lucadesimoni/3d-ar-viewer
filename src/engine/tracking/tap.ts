/**
 * What counts as a tap, in one place.
 *
 * Placement is the most consequential gesture in this app, and until now two
 * paths had two different ideas about when it happens. A WebXR session takes a
 * `select`, which fires when a touch ends and says nothing about whether it
 * moved; the camera path — the only path an iPhone or iPad in Safari has —
 * placed on `pointerdown`, the instant the finger landed. On Android a swipe
 * across the camera view therefore placed the assembly, and on iOS it still
 * did, at the point where the finger first touched.
 *
 * So: one rule, both paths. Sixteen pixels is roughly the slop a platform
 * allows a tap of its own; seven tenths of a second is where a tap becomes a
 * press.
 */

/** How far a finger may travel and still be a tap, in CSS pixels. */
export const TAP_TRAVEL_PX = 16;
/** And how long it may rest, in milliseconds. */
export const TAP_HOLD_MS = 700;

export interface Gesture {
  travelPx: number;
  heldMs: number;
}

export function isTap({ travelPx, heldMs }: Gesture): boolean {
  return travelPx <= TAP_TRAVEL_PX && heldMs <= TAP_HOLD_MS;
}
