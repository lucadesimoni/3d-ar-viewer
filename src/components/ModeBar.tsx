import { useStore, type ViewMode } from '../state/store';
import { assemblyTimeline } from '../engine/animation';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { useEffect, useRef, useState } from 'react';

const MODES: { id: ViewMode; label: string; icon: string }[] = [
  { id: 'guide', label: 'Guide', icon: '◎' },
  { id: 'explore', label: 'Explore', icon: '✋' },
  { id: 'explode', label: 'Exploded', icon: '❋' },
  { id: 'animate', label: 'Animate', icon: '▶' },
];

/** Bottom bar: view-mode switch, explode slider, and the animation scrubber. */
export function ModeBar(): JSX.Element {
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const explodeFactor = useStore((s) => s.explodeFactor);
  const setExplodeFactor = useStore((s) => s.setExplodeFactor);
  const reset = useStore((s) => s.reset);
  const annotating = useStore((s) => s.annotating);
  const setAnnotating = useStore((s) => s.setAnnotating);

  return (
    <div className="mode-bar">
      <div className="mode-switch">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`mode ${viewMode === m.id ? 'active' : ''}`}
            onClick={() => setViewMode(m.id)}
          >
            <span className="mode-icon">{m.icon}</span>
            <span className="mode-label">{m.label}</span>
          </button>
        ))}
      </div>

      {viewMode === 'explode' && (
        <label className="explode-slider">
          Spread
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={explodeFactor}
            onChange={(e) => setExplodeFactor(Number(e.target.value))}
          />
        </label>
      )}

      {viewMode === 'animate' && <AnimationScrubber />}

      {/* Notes are written *while* reading the guide, or with the view
          exploded, or with the animation paused on the step in question — so
          this is a switch beside the modes, not one of them. */}
      <button
        className={`mode note-mode ${annotating ? 'active' : ''}`}
        aria-pressed={annotating}
        onClick={() => {
          const on = !annotating;
          setAnnotating(on);
          // The same tap cannot both note a part and re-place the assembly.
          if (on) getActiveManager()?.setPlacementActive(false);
        }}
      >
        <span className="mode-icon">✎</span>
        <span className="mode-label">{annotating ? 'Done noting' : 'Add notes'}</span>
      </button>

      <button className="ghost reset" onClick={reset}>Reset build</button>
    </div>
  );
}

/**
 * Plays the full build animation in dependency order. The timeline is derived
 * from the assembly once, then scrubbed by writing into the store's animation
 * slot, which the SceneManager samples each frame.
 */
function AnimationScrubber(): JSX.Element {
  const assembly = useStore((s) => s.assembly);
  const timeline = useRef(assemblyTimeline(assembly));
  const tRef = useRef(0);
  const rafRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * State, not a ref.
   *
   * It was a ref, so pressing play re-rendered nothing and the button kept its
   * "▶ / ❚❚" label whatever it was doing. A control that looks identical before
   * and after you press it is a control that did not work, as far as anyone
   * watching is concerned — and that is exactly how this mode was reported.
   */
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(timeline.current.durationS);
  /** The loop reads this synchronously; `playing` is for the operator to see. */
  const running = useRef(false);

  useEffect(() => {
    timeline.current = assemblyTimeline(assembly);
    setDuration(timeline.current.durationS);
    useStore.getState().setAnimation(timeline.current, tRef.current);
  }, [assembly]);

  // The store carries the scrub position so the scene can read it; we set it
  // through a tiny escape hatch on the store to avoid threading it everywhere.
  const setAnimation = useStore.getState().setAnimation;
  const apply = (t: number): void => {
    tRef.current = t;
    setAnimation(timeline.current, t);
    if (inputRef.current) inputRef.current.value = String(t);
  };

  const stop = (): void => {
    running.current = false;
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  };

  const start = (from = tRef.current >= timeline.current.durationS ? 0 : tRef.current): void => {
    running.current = true;
    setPlaying(true);
    const origin = performance.now() - from * 1000;
    const loop = (): void => {
      if (!running.current) return;
      const t = (performance.now() - origin) / 1000;
      if (t >= timeline.current.durationS) {
        apply(timeline.current.durationS);
        stop();
        return;
      }
      apply(t);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  // Play once on arrival. A mode whose whole purpose is motion, entered to find
  // a still picture and one small button, reads as broken — and was reported
  // as exactly that.
  useEffect(() => {
    start(0);
    return () => {
      running.current = false;
      cancelAnimationFrame(rafRef.current);
    };
    // Mount only: re-running this on every render would restart the playback
    // under the operator's hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scrubber">
      <button
        className="play"
        aria-pressed={playing}
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => (playing ? stop() : start())}
      >{playing ? '❚❚' : '▶'}</button>
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={duration}
        step={0.01}
        defaultValue={0}
        onChange={(e) => {
          stop();
          apply(Number(e.target.value));
        }}
      />
      <div className="markers">
        {timeline.current.markers.map((m) => (
          <span key={m.stepId} title={m.title}>•</span>
        ))}
      </div>
    </div>
  );
}
