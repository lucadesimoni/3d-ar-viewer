import { useEffect, useRef, useState } from 'react';
import { SceneManager, type SceneRenderState } from './SceneManager';
import { setActiveManager } from './managerRegistry';
import type { RecognitionStatus } from '../../vision/verdict';
import { useStore } from '../../state/store';
import type { AssemblyDef } from '../../engine/types';

/**
 * Bridge between the Zustand store and the imperative `SceneManager`.
 *
 * The manager is created once for the lifetime of the canvas; store changes are
 * pushed into it via `update`, and a light rAF loop drives the time-based
 * effects (error pulse, animation scrub) that have no store event to hang off.
 * React never renders a 3D frame — it only hands the manager fresh state.
 */
export function useSceneManager(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  opts: { transparent?: boolean; grid?: boolean } = {},
): { manager: SceneManager | undefined } {
  const [manager, setManager] = useState<SceneManager>();
  const managerRef = useRef<SceneManager | undefined>(undefined);
  const loadedAssembly = useRef<AssemblyDef | undefined>(undefined);

  useEffect(() => {
    if (!canvasRef.current) return;
    const assembly: AssemblyDef = useStore.getState().assembly;
    let disposed = false;
    let raf = 0;

    // Engine creation is async (WebGPU with a WebGL2 fallback), so build the
    // manager in a promise and guard against unmount before it resolves.
    void SceneManager.create(canvasRef.current, assembly, { transparent: opts.transparent }).then((m) => {
      if (disposed) { m.dispose(); return; }
      if (opts.grid) m.addGroundGrid();
      m.frameCamera();
      loadedAssembly.current = assembly;
      managerRef.current = m;
      setActiveManager(m);
      setManager(m);
      const loop = (): void => {
        m.tick();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      managerRef.current?.dispose();
      setActiveManager(undefined);
      managerRef.current = undefined as SceneManager | undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef]);

  // The scene is built once, so AR toggling must be applied to the live manager
  // rather than rebuilt — otherwise the canvas stays opaque over the camera.
  useEffect(() => {
    managerRef.current?.setTransparent(Boolean(opts.transparent));
  }, [opts.transparent, manager]);

  // Push store state into the manager whenever the relevant slices change.
  useEffect(() => {
    const push = (): void => {
      const m = managerRef.current;
      if (!m) return;
      const s = useStore.getState();
      // Rebuild the scene when the assembly itself changes — otherwise the
      // picker (and the Mendix assembly binding) would swap the data while the
      // 3D view kept rendering the previous model's meshes.
      if (s.assembly !== loadedAssembly.current) {
        m.loadAssembly(s.assembly);
      }
      loadedAssembly.current = s.assembly;
      const step = s.assembly.steps.find((st) => st.id === s.activeStepId);
      const partIds = new Set(s.assembly.parts.map((p) => p.id));
      const recognitionByPart = new Map<string, RecognitionStatus>();
      for (const o of s.recognition?.objects ?? []) {
        if (partIds.has(o.label)) recognitionByPart.set(o.label, o.status);
      }
      const state: SceneRenderState = {
        placements: s.placements,
        severityByPart: s.severityByPart,
        selectedPartId: s.selectedPartId,
        activePartIds: new Set(step?.partIds ?? []),
        explodeFactor: s.explodeFactor,
        // Whenever a timeline exists, not only in Animate mode: the per-step
        // "Show me" plays one transiently from the guide.
        timeline: s.animationTimeline,
        timelineT: s.animationT,
        showBackground: true,
        // Animate too, and for the reason the mode exists: on an untouched build
        // every part is a ghost, so entering Animate hid everything but the
        // active step and the timeline then moved the invisible. "The animation
        // doesn't seem to work yet" was a fair reading of that.
        showGhosts: s.viewMode === 'guide' || s.viewMode === 'explore' || s.viewMode === 'animate',
        recognitionByPart,
      };
      m.update(state);
      m.setAnchor(s.anchor);
    };
    push();
    return useStore.subscribe(push);
  }, [manager]);

  return { manager };
}
