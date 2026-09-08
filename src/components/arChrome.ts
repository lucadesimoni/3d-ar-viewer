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
/**
 * Cached, because this is called from an animation frame.
 *
 * `getBoundingClientRect` is a layout read, and a layout read inside the frame
 * loop is a synchronous layout on a phone. The HUD's top edge changes when a
 * sheet opens, the step title wraps or the device turns — none of them at frame
 * rate — so it is measured on a slow beat instead of sixty times a second.
 */
let cached = { at: 0, value: 1 };
const CACHE_MS = 250;

export function arChromeTop(now = typeof performance !== 'undefined' ? performance.now() : 0): number {
  if (now - cached.at < CACHE_MS) return cached.value;
  cached = { at: now, value: measureChromeTop() };
  return cached.value;
}

/** Forget the cached measurement — for tests, and for a deliberate re-measure. */
export function resetArChromeCache(): void {
  cached = { at: 0, value: 1 };
}

function measureChromeTop(): number {
  if (typeof document === 'undefined') return 1;
  const hud = document.querySelector('.ar-hud');
  if (!hud) return 1;
  const rect = hud.getBoundingClientRect();
  const height = window.innerHeight || rect.bottom;
  if (!height || rect.top <= 0) return 1;
  return Math.max(0, Math.min(1, rect.top / height));
}
