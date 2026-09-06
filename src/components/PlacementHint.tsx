import { useStore } from '../state/store';

/** What the surface the operator is aiming at is called, from its height. */
export function surfaceName(heightM: number): string {
  if (heightM < 0.02) return 'floor';
  if (heightM < 0.85) return 'table';
  return 'bench';
}

/**
 * The one line of AR chrome that has to be there: what the app is waiting for.
 *
 * An overlay that shows nothing until a surface is found looks broken unless it
 * says so. This states the current anchoring source in the operator's terms —
 * aim and tap, or "hold still, I can see the shelf" — and gets out of the way
 * the moment the assembly is anchored to something real.
 */
export function PlacementHint(): JSX.Element | null {
  const placement = useStore((s) => s.arPlacement);
  const quality = useStore((s) => s.anchorQuality);
  const target = useStore((s) => s.assembly.recognition);
  const source = useStore((s) => s.arSource);
  const motion = useStore((s) => s.arMotion);
  const surface = surfaceName(useStore((s) => s.arSettings.surfaceHeightM));

  if (placement === 'idle') return null;

  // Worth saying out loud: without orientation the overlay cannot follow the
  // phone, and the floor plane a placement rests on is a guess. The instruction
  // still stands — tapping puts the assembly in front of the operator.
  const blind = source === 'camera' && !motion;

  if (placement === 'awaiting') {
    const looking = target ? ' — or point it at the shelf' : '';
    return (
      <div className={`placement-hint ${blind ? 'warn' : ''}`}>
        <span className={`dot ${blind ? 'warn' : ''}`} />
        {blind
          ? 'No motion sensor — tap to place it straight ahead'
          : source === 'webxr'
            ? `Move the phone to find a surface, then tap${looking}`
            : `Tap the ${surface} to place${looking}`}
      </div>
    );
  }

  // A percentage is only meaningful where it measures a match. A placement the
  // operator made by hand is exactly as good as their aim, and showing it as
  // "60%" read like a progress bar that had stalled. Say what to do instead.
  const placed = placement === 'recognized'
    ? `Locked onto the ${target?.label ?? 'object'} · ${Math.round(quality * 100)}%`
    : placement === 'marker' ? `Locked onto the marker · ${Math.round(quality * 100)}%`
      : placement === 'floor' ? `Placed on the ${surface} — "Move" to reposition`
        : 'Registered manually';
  return (
    <div className={`placement-hint placed ${blind ? 'warn' : ''}`}>
      <span className={`dot ${blind ? 'warn' : 'ok'}`} />
      {placed}
      <span className="hint-mode">{blind ? 'no sensor' : source === 'webxr' ? 'WebXR' : 'Camera'}</span>
    </div>
  );
}
