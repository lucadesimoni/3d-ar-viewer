/**
 * Where a scrolling strip should sit so one item in it is in view.
 *
 * Positions are along the strip's scrolling axis, in its content's
 * coordinates: `scroll` is the current offset, `view` the visible length,
 * `itemStart` and `itemSize` the item's place in the content. Undefined when
 * the item is already wholly in view with `margin` to spare, so a tap on a
 * chip that is on screen never moves the strip under the finger. Otherwise
 * the item is centred, which also shows its neighbours on both sides.
 */
export function revealOffset(
  scroll: number, view: number, itemStart: number, itemSize: number, margin = 8,
): number | undefined {
  const inView = itemStart - margin >= scroll && itemStart + itemSize + margin <= scroll + view;
  if (inView) return undefined;
  return Math.max(0, Math.round(itemStart + itemSize / 2 - view / 2));
}
