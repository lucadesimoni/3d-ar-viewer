import type { ReactNode } from 'react';
import { useScrollOverflow } from '../ui/useScrollOverflow';

/**
 * The phone's bottom sheet — one shared shell for the view-mode bar and the
 * register/collaborate/BOM/log drawers, whichever is currently shown. Both
 * are the same `overflow: auto` box with a `46dvh` cap; only the content
 * inside differs. `watch` should change whenever that content does (a tab
 * switch, not just the sheet opening), so the affordance re-measures rather
 * than freezing on whatever fit the first tab that was open.
 */
export function MobileSheet({ watch, children }: { watch: unknown; children: ReactNode }): JSX.Element {
  const { ref, hasMore } = useScrollOverflow<HTMLDivElement>('y', [watch]);
  return (
    <div className={`panel mobile-sheet ${hasMore ? 'has-more' : ''}`} ref={ref}>
      {children}
      {hasMore && <span className="scroll-more down" aria-hidden="true">More ↓</span>}
    </div>
  );
}
