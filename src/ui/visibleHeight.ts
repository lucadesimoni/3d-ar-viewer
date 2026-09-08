/**
 * Publish the height the operator can actually see, as `--app-h`.
 *
 * `100dvh` is the page's guess at the visible area, and two devices have now
 * disagreed with it in opposite directions:
 *
 *  - iOS Safari anchors a `position: fixed` element to the *layout* viewport,
 *    the tall one without the toolbars, so a bar pinned to its bottom hides
 *    behind them. That is why the AR HUD sits in the flow of the app's column
 *    and has to keep sitting there.
 *  - An iPad running the app through the Needle App Clip reported the other
 *    half: AR works, but the bottom bar and the step strip are sometimes not
 *    there at all — which is what the last row of a column taller than the
 *    host's visible area looks like. Nothing errors; the controls are gone.
 *
 * `visualViewport` is neither a guess nor a constant: it reports what is
 * visible right now, host chrome and toolbars excluded, and says when that
 * changes. Both reports are satisfied by measuring instead of assuming.
 */
export function trackVisibleHeight(root: HTMLElement = document.documentElement): () => void {
  const vv = window.visualViewport;
  const apply = (): void => {
    const h = vv?.height ?? window.innerHeight;
    if (h > 0) root.style.setProperty('--app-h', `${Math.round(h)}px`);
  };
  apply();
  // A toolbar sliding in, a keyboard, a clip resizing its presentation, the
  // device turning: all of them arrive here.
  vv?.addEventListener('resize', apply);
  vv?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
  return () => {
    vv?.removeEventListener('resize', apply);
    vv?.removeEventListener('scroll', apply);
    window.removeEventListener('resize', apply);
    window.removeEventListener('orientationchange', apply);
  };
}
