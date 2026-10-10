import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Is there more of this scrolling container to see, past the edge it starts
 * at? Measured, not guessed — the same question `StepGuide.tsx` first asked
 * of its own step card, where a box that clipped and just stopped looked
 * exactly like one that was broken. A container that genuinely scrolls but
 * gives no sign of it reads the same way: the content is reachable by touch,
 * but nothing on screen said so.
 *
 * The trailing edge (right, or down) is `hasMore`. The leading edge is
 * `hasLess`: these containers start at step 1, the first datum, the top of a
 * list, so for a long time only the trailing edge mattered. Then the phone's
 * step strip began following the active step, and from step 12 the first
 * seven were off to the left with nothing saying so.
 */
export function useScrollOverflow<T extends HTMLElement>(
  axis: 'x' | 'y',
  deps: readonly unknown[],
): { ref: RefObject<T | null>; hasMore: boolean; hasLess: boolean } {
  const ref = useRef<T | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [hasLess, setHasLess] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) { setHasMore(false); setHasLess(false); return; }
    const update = (): void => {
      const remaining = axis === 'x'
        ? el.scrollWidth - el.clientWidth - el.scrollLeft
        : el.scrollHeight - el.clientHeight - el.scrollTop;
      // A few pixels of slack: sub-pixel layout rounding must never read as
      // "still more to scroll" once a container has genuinely reached its end.
      setHasMore(remaining > 4);
      setHasLess((axis === 'x' ? el.scrollLeft : el.scrollTop) > 4);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis, ...deps]);

  return { ref, hasMore, hasLess };
}
