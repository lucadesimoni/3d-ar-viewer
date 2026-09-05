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

  if (placement === 'idle') return null;

  if (placement === 'awaiting') {
    const looking = target ? ' — or point it at the shelf' : '';
    return (
      <div className="placement-hint">
        <span className="dot" />
        {capabilities?.immersiveAr
          ? `Move the phone to find a surface, then tap${looking}`
          : `Tap the floor to place${looking}`}
      </div>
    );
  }

  const source =
    placement === 'recognized' ? `Locked onto the ${target?.label ?? 'object'}`
      : placement === 'marker' ? 'Locked onto the marker'
        : placement === 'floor' ? 'Placed on the floor'
          : 'Registered manually';
  return (
    <div className="placement-hint placed">
      <span className="dot ok" />
      {source} · {Math.round(quality * 100)}%
    </div>
  );
}
