import { useStore } from '../state/store';
import type { Capabilities } from '../engine/tracking/capabilities';

/**
 * The one line of AR chrome that has to be there: what the app is waiting for.
 *
 * An overlay that shows nothing until a surface is found looks broken unless it
 * says so. This states the current anchoring source in the operator's terms —
 * aim and tap, or "hold still, I can see the shelf" — and gets out of the way
 * the moment the assembly is anchored to something real.
 */
export function PlacementHint({ capabilities }: { capabilities?: Capabilities }): JSX.Element | null {
  const placement = useStore((s) => s.arPlacement);
  const quality = useStore((s) => s.anchorQuality);
  const target = useStore((s) => s.assembly.recognition);
  const source = useStore((s) => s.arSource);
  const motion = useStore((s) => s.arMotion);

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
          : capabilities?.immersiveAr
            ? `Move the phone to find a surface, then tap${looking}`
            : `Tap the floor to place${looking}`}
      </div>
    );
  }

  const sourceLabel =
    placement === 'recognized' ? `Locked onto the ${target?.label ?? 'object'}`
      : placement === 'marker' ? 'Locked onto the marker'
        : placement === 'floor' ? 'Placed on the floor'
          : 'Registered manually';
  return (
    <div className={`placement-hint placed ${blind ? 'warn' : ''}`}>
      <span className={`dot ${blind ? 'warn' : 'ok'}`} />
      {sourceLabel} · {Math.round(quality * 100)}%
      <span className="hint-mode">{blind ? 'no sensor' : source === 'webxr' ? 'WebXR' : 'Camera'}</span>
    </div>
  );
}
