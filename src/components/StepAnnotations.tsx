import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { arChromeTop } from './arChrome';

/**
 * Names the parts the current step is about, pinned to those parts.
 *
 * The step card says "fit the side panels"; the 3D view highlights two boards.
 * Connecting the two was left to the operator, which is fine for a gearbox with
 * eleven parts and hopeless for a rack with a hundred. These are the labels that
 * close it: each active part carries its own name, projected onto it every
 * frame, so the instruction and the geometry cannot be read apart.
 *
 * Three rules keep it from becoming clutter, which is what usually kills
 * on-object labels: a tag is dropped when it would sit on top of one already
 * placed — four identical shelves in a row need one label, not four overlapping
 * ones — dropped when it would fall behind the AR HUD, and the remainder is
 * reported as a count rather than drawn.
 */

interface Tag {
  partId: string;
  name: string;
  x: number;
  y: number;
}

/** Minimum gap between two tags, as a fraction of the viewport's smaller side. */
const MIN_SEPARATION = 0.11;
const MAX_TAGS = 6;
/**
 * How far a tag must move before the DOM is told about it.
 *
 * The projection runs every animation frame, and it used to publish every
 * frame too: a new array into React state sixty times a second, which is sixty
 * reconciliations, style recalculations and layouts for labels that had not
 * moved a pixel. Two thousandths of the viewport is well under what an eye
 * resolves and well over the jitter of a projection, so a still phone now costs
 * nothing at all and a moving one costs only what it must.
 */
const TAG_EPSILON = 0.002;

/** Whether anything about the tags is worth re-rendering for. */
function tagsDiffer(a: Tag[], b: Tag[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((t, i) => (
    t.partId !== b[i].partId
    || Math.abs(t.x - b[i].x) > TAG_EPSILON
    || Math.abs(t.y - b[i].y) > TAG_EPSILON
  ));
}

export function StepAnnotations(): JSX.Element | null {
  const assembly = useStore((s) => s.assembly);
  const activeStepId = useStore((s) => s.activeStepId);
  const viewMode = useStore((s) => s.viewMode);
  const [tags, setTags] = useState<Tag[]>([]);
  const [hidden, setHidden] = useState(0);
  const raf = useRef(0);
  // What the DOM currently shows, so a frame that changes nothing costs nothing.
  const published = useRef<Tag[]>([]);
  const hiddenCount = useRef(0);
  const publishes = useRef(0);

  const step = assembly.steps.find((s) => s.id === activeStepId);
  const enabled = viewMode === 'guide' && Boolean(step);

  useEffect(() => {
    if (!enabled || !step) {
      published.current = [];
      hiddenCount.current = 0;
      setTags([]);
      setHidden(0);
      return;
    }
    const names = new Map(assembly.parts.map((p) => [p.id, p.name]));

    const onFrame = (): void => {
      const manager = getActiveManager();
      const next: Tag[] = [];
      let dropped = 0;
      // In AR the bottom of the screen is the HUD; a label there is a fragment
      // sticking out from behind the control bar, not an annotation.
      const limit = arChromeTop();
      if (manager) {
        for (const partId of step.partIds) {
          const p = manager.projectPart(partId);
          if (!p || !p.onScreen || p.y > limit) { dropped++; continue; }
          const crowded = next.some((t) => Math.hypot(t.x - p.x, t.y - p.y) < MIN_SEPARATION);
          if (crowded || next.length >= MAX_TAGS) { dropped++; continue; }
          next.push({ partId, name: names.get(partId) ?? partId, x: p.x, y: p.y });
        }
      }
      if (tagsDiffer(next, published.current)) {
        published.current = next;
        publishes.current += 1;
        // A counted handle, alongside the `spatialStore` and `spatialScene`
        // ones this app already exposes for driving it from a browser check.
        // The rule this layer lives by — a frame that changes nothing costs
        // nothing — is a property, not a duration, and a duration is what my
        // first check measured: a threshold tuned on one machine, which then
        // failed CI on correct code at 0.48 ms against 0.45.
        (window as unknown as { spatialLabelPublishes?: number })
          .spatialLabelPublishes = publishes.current;
        setTags(next);
      }
      if (dropped !== hiddenCount.current) {
        hiddenCount.current = dropped;
        setHidden(dropped);
      }
      raf.current = requestAnimationFrame(onFrame);
    };
    raf.current = requestAnimationFrame(onFrame);
    return () => cancelAnimationFrame(raf.current);
  }, [enabled, step, assembly]);

  if (!enabled || tags.length === 0) return null;

  return (
    <div className="step-annotations" aria-hidden="true">
      {tags.map((t) => (
        <div key={t.partId} className="step-tag" style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }}>
          <span className="step-tag-dot" />
          <span className="step-tag-label">{t.name}</span>
        </div>
      ))}
      {hidden > 0 && <div className="step-tag-more">+{hidden} more in this step</div>}
    </div>
  );
}
