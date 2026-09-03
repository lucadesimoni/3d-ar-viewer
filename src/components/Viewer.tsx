import { useEffect, useRef } from 'react';
import { useSceneManager } from '../render/babylon/useSceneManager';
import { useStore } from '../state/store';

/**
 * The 3D canvas. Owns nothing but the DOM element and the tap-to-select
 * gesture; all rendering lives in the `SceneManager` behind the hook.
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
    return () => canvas.removeEventListener('pointerdown', onPick);
  }, [manager, selectPart]);

  return <canvas ref={canvasRef} className="viewer-canvas" style={{ touchAction: 'none' }} />;
}
