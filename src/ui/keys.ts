import type { KeyboardEvent } from 'react';

/**
 * Enter or Space on a focused row does what a click does — the keyboard half
 * of making a clickable element that is not a button usable.
 */
export function activateOnKey(e: KeyboardEvent, action: () => void): void {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  action();
}
