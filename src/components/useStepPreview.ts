import { useCallback, useEffect, useRef } from 'react';
import { stepTimeline } from '../engine/animation';
import { useStore } from '../state/store';

/**
 * "Show me": play the active step's parts flying into place.
 *
 * A step's parts used to simply appear at their target — the engine had a
 * per-step timeline all along and nothing ever called it. Watching a part come
 * in along its approach direction is the whole point: it shows *how* the part
 * goes in, which way round it is, and in what order within the step, none of
 * which a static ghost conveys.
 *
 * It is a demonstration, so it changes nothing: placements are untouched and
 * the timeline is dropped at the end, returning the view to exactly what it was.
 */
export function useStepPreview(): { play: () => void; stop: () => void; playing: boolean } {
  const raf = useRef<number | undefined>(undefined);
  const playing = useRef(false);

  const stop = useCallback(() => {
    if (raf.current !== undefined) cancelAnimationFrame(raf.current);
    raf.current = undefined;
    playing.current = false;
    useStore.getState().setAnimation(undefined, 0);
  }, []);

  const play = useCallback(() => {
    const state = useStore.getState();
    const step = state.assembly.steps.find((s) => s.id === state.activeStepId);
    if (!step) return;
    stop();

    const timeline = stepTimeline(state.assembly, step);
    const startedAt = performance.now();
    playing.current = true;
    state.setAnimation(timeline, 0);

    const frame = (now: number): void => {
      const t = (now - startedAt) / 1000;
      if (t >= timeline.durationS) {
        // Hold the finished pose for a moment so the eye lands on the result,
        // then hand the view back exactly as it was.
        useStore.getState().setAnimation(timeline, timeline.durationS);
        raf.current = undefined;
        window.setTimeout(() => { if (playing.current) stop(); }, 500);
        return;
      }
      useStore.getState().setAnimation(timeline, t);
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return { play, stop, playing: playing.current };
}
