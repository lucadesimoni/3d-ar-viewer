import { useEffect, useRef } from 'react';
import { useSceneManager } from '../render/babylon/useSceneManager';
import { useStore } from '../state/store';

/**
 * The 3D canvas: selection, and dragging a part into place.
 *
 * Dropping a part is where the whole fit story starts — the snap solver runs on
 * release, the tolerance check follows from where it lands, and the diagnostics
 * panel reacts. Moving is reported continuously so the part follows the finger,
 * but only the release is committed, so the solver sees one decision instead of
 * sixty intermediate ones.
 */
export function Viewer({ transparent = false }: { transparent?: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { manager } = useSceneManager(canvasRef, { transparent, grid: !transparent });
  const selectPart = useStore((s) => s.selectPart);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !manager) return;
    const onPick = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const id = manager.pickPartAt(e.clientX - rect.left, e.clientY - rect.top);
      selectPart(id);
    };
    canvas.addEventListener('pointerdown', onPick);
    const stopDrag = manager.startPartDragging({
      onMove: (partId, pose) => useStore.getState().movePart(partId, pose),
      onDrop: (partId, pose) => useStore.getState().placePart(partId, pose),
    });
    return () => {
      canvas.removeEventListener('pointerdown', onPick);
      stopDrag();
    };
  }, [manager, selectPart]);

  return <canvas ref={canvasRef} className="viewer-canvas" style={{ touchAction: 'none' }} />;
}
