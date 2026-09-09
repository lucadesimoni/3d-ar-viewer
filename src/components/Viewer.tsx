import { useCallback, useEffect, useRef } from 'react';
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
  // `transparent` is AR. There the overlay is a reference registered to a real
  // workpiece, and a tap means "put it here" — not "pick this part up". Leaving
  // drag and select live in AR meant a stray touch quietly placed a part and
  // opened an inspector over the guidance.
  const interactive = !transparent;

  /**
   * Only the step in hand can be moved.
   *
   * Every part used to be draggable at any moment, in every view mode, with no
   * warning — including parts from steps that are not due yet. A pointer-down
   * that happened to land on a mesh took the camera's gesture and started
   * moving the model. Restricting it to the active step is what the guided flow
   * already claims: this is the step, these are its parts, place them.
   *
   * And nothing at all while a build animation is running: the animated pose
   * wins over the placement, so a drag moved nothing visibly, wrote to the
   * store the whole time, and committed the *animated* position on release.
   */
  const canDrag = useCallback((partId: string): boolean => {
    const state = useStore.getState();
    if (state.animationTimeline) return false;
    const step = state.assembly.steps.find((s) => s.id === state.activeStepId);
    return Boolean(step?.partIds.includes(partId));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !manager || !interactive) return;
    const onPick = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const id = manager.pickPartAt(e.clientX - rect.left, e.clientY - rect.top);
      selectPart(id);
    };
    canvas.addEventListener('pointerdown', onPick);
    const stopDrag = manager.startPartDragging({
      onMove: (partId, pose) => useStore.getState().movePart(partId, pose),
      onDrop: (partId, pose) => useStore.getState().placePart(partId, pose),
      canDrag,
    });
    // What can be picked up, shown before it is. Direct manipulation with no
    // announcement is a discovery, not an affordance — a tester read it as a
    // bug ("what irritates me is that I can move the elements").
    const onHover = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const id = manager.pickPartAt(e.clientX - rect.left, e.clientY - rect.top);
      canvas.style.cursor = id && canDrag(id) ? 'grab' : '';
    };
    canvas.addEventListener('pointermove', onHover);
    return () => {
      canvas.removeEventListener('pointerdown', onPick);
      canvas.removeEventListener('pointermove', onHover);
      canvas.style.cursor = '';
      stopDrag();
    };
  }, [manager, selectPart, interactive, canDrag]);

  return <canvas ref={canvasRef} className="viewer-canvas" style={{ touchAction: 'none' }} />;
}
