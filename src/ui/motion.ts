/**
 * Whether the operator has asked their device for less motion.
 *
 * Read live (a cached query's `matches` is a property read), so a change in
 * system settings applies without a reload. False wherever it cannot be asked.
 */
let query: MediaQueryList | undefined;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  query ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return query.matches;
}
