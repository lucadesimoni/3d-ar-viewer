import { useStore, type ViewMode } from '../state/store';
import { assemblyTimeline } from '../engine/animation';
import { useEffect, useRef } from 'react';

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
  const playing = useRef(false);
  const rafRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    timeline.current = assemblyTimeline(assembly);
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

  const toggle = (): void => {
    playing.current = !playing.current;
    if (playing.current) {
      const start = performance.now() - tRef.current * 1000;
      const loop = (): void => {
        if (!playing.current) return;
        const t = (performance.now() - start) / 1000;
        if (t >= timeline.current.durationS) {
          apply(timeline.current.durationS);
          playing.current = false;
          return;
        }
        apply(t);
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(rafRef.current);
    }
  };

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return (
    <div className="scrubber">
      <button className="play" onClick={toggle}>▶ / ❚❚</button>
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={timeline.current.durationS}
        step={0.01}
        defaultValue={0}
        onChange={(e) => {
          playing.current = false;
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
