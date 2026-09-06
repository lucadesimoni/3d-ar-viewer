import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { getActiveManager } from '../render/babylon/managerRegistry';

const ARROWS = { up: '↑', down: '↓', left: '←', right: '→', behind: '↺', here: '' } as const;
/** Below this the assembly is only just outside the frame; a nudge would nag. */
const NAG_THRESHOLD_DEG = 4;
const POLL_MS = 200;

/**
 * "It says placed, but I cannot see anything."
 *
 * Nothing is wrong when that happens: you aim at the floor two metres ahead,
 * tap, then raise the phone to look forward, and the assembly — correctly
 * anchored 1.45 m below eye level — is now well under the bottom edge of a
 * 60-degree view. With no head tracking to walk around it and no depth cue to
 * suggest where it went, the only conclusion available to the operator is that
 * AR is broken.
 *
 * So say where it is, and offer the one action that fixes it.
 */
export function OffscreenNudge({ onBringInFront }: { onBringInFront: () => void }): JSX.Element | null {
  const placement = useStore((s) => s.arPlacement);
  const source = useStore((s) => s.arSource);
  const [state, setState] = useState<{ direction: keyof typeof ARROWS; distanceM: number } | undefined>();

  const anchored = source !== undefined && placement !== 'idle' && placement !== 'awaiting';

  useEffect(() => {
    if (!anchored) { setState(undefined); return; }
    const id = window.setInterval(() => {
      const view = getActiveManager()?.anchorViewState();
      setState(view && !view.onScreen && view.offScreenDeg > NAG_THRESHOLD_DEG
        ? { direction: view.direction, distanceM: view.distanceM }
        : undefined);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [anchored]);

  if (!state) return null;

  const where = state.direction === 'behind'
    ? 'behind you'
    : `${state.distanceM.toFixed(1)} m away, off screen`;

  return (
    <div className="offscreen-nudge">
      <span className="offscreen-arrow" aria-hidden>{ARROWS[state.direction]}</span>
      <span className="offscreen-text">
        The assembly is {where}
        <em>{state.direction === 'behind' ? 'Turn around' : `Look ${state.direction}`}, or bring it to you</em>
      </span>
      <button className="offscreen-act" onClick={onBringInFront}>Bring&nbsp;it&nbsp;here</button>
    </div>
  );
}
