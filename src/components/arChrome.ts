/**
 * Where the AR chrome starts, as a fraction of the viewport's height.
 *
 * On-object labels are pinned to whatever they name, and in AR the bottom of
 * the screen belongs to the HUD. A label on a part low in the frame ended up
 * *behind* the control bar, showing as a fragment poking out from under it —
 * the same fault the recognition banner had, and it looks like a rendering bug
 * rather than a label doing its job.
 *
 * A label cannot be docked the way a banner can: its position is its meaning.
 * So it is dropped instead, and counted in the "+N more" the caller already
 * shows. Returns 1 when there is no AR chrome, so nothing is dropped outside AR.
 */
export function arChromeTop(): number {
  if (typeof document === 'undefined') return 1;
  const hud = document.querySelector('.ar-hud');
  if (!hud) return 1;
  const rect = hud.getBoundingClientRect();
  const height = window.innerHeight || rect.bottom;
  if (!height || rect.top <= 0) return 1;
  return Math.max(0, Math.min(1, rect.top / height));
}
