/**
 * Whether the AR controls are where an operator can reach them.
 *
 * An iPad inside the Needle App Clip showed the model correctly over the room
 * and not one control anywhere — no way to place, exit or send a log. Three
 * candidate causes were never told apart (an app box collapsed to nothing, a
 * column taller than the host's visible area, an overlay the host does not
 * composite), because nothing measured it at the moment it happened. This is
 * that measurement, and what decides whether the rescue button appears.
 */
export interface Box { top: number; left: number; bottom: number; right: number; width: number; height: number }

/** Too small to see or press is not on screen. */
const MIN_SIZE_PX = 20;

export function controlsOnScreen(bar: Box | undefined, view: { width: number; height: number }): boolean {
  if (!bar || bar.width < MIN_SIZE_PX || bar.height < MIN_SIZE_PX) return false;
  return bar.top >= -1 && bar.left >= -1 && bar.bottom <= view.height + 1 && bar.right <= view.width + 1;
}

/**
 * The area the operator can see, at the page's own scale.
 *
 * At the unzoomed scale, so a pinch-zoom (which hides most of the page on
 * purpose) is not mistaken for missing controls; and the smaller of the two
 * viewports, because the report that started this was a column taller than
 * the host's visible area.
 */
export function visibleArea(win: Window = window): { width: number; height: number } {
  const vv = win.visualViewport;
  const scale = vv?.scale || 1;
  return {
    width: Math.min(win.innerWidth, vv ? vv.width * scale : win.innerWidth),
    height: Math.min(win.innerHeight, vv ? vv.height * scale : win.innerHeight),
  };
}
