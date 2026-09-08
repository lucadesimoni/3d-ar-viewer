import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { arChromeTop } from './arChrome';

/**
 * Operator notes: placing them, and showing them where they belong.
 *
 * A note is about a component, so it is pinned to one — tap a part, type,
 * done. It then rides that part's own frame, which is what makes it survive the
 * assembly being re-placed, exploded, or animated. A note that stayed at a
 * point in the room would be left standing where the part used to be.
 *
 * The tap is taken from the DOM rather than from Babylon's own pointer
 * handling. In an AR session the render canvas is hidden so it cannot paint
 * over the camera image, and a hidden element receives no pointer events at
 * all — the only tap that arrives is the one on the overlay.
 */

interface Pin {
  id: string;
  text: string;
  x: number;
  y: number;
}

/** How far a pin must move before the DOM is told; see StepAnnotations. */
const EPSILON = 0.002;

export function Annotations(): JSX.Element | null {
  const annotating = useStore((s) => s.annotating);
  const annotations = useStore((s) => s.annotations);
  const addAnnotation = useStore((s) => s.addAnnotation);
  const removeAnnotation = useStore((s) => s.removeAnnotation);
  const [pins, setPins] = useState<Pin[]>([]);
  const [draft, setDraft] = useState<{ partId: string; local: [number, number, number]; part: string } | undefined>();
  const [text, setText] = useState('');
  const [openId, setOpenId] = useState<string | undefined>();
  const [missed, setMissed] = useState(false);
  const published = useRef<Pin[]>([]);
  const raf = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  // Follow the parts.
  useEffect(() => {
    if (annotations.length === 0) {
      published.current = [];
      setPins([]);
      return;
    }
    const onFrame = (): void => {
      const manager = getActiveManager();
      const limit = arChromeTop();
      const next: Pin[] = [];
      if (manager) {
        for (const note of annotations) {
          const p = manager.projectAnnotation(note.partId, note.local);
          if (!p || !p.onScreen || p.y > limit) continue;
          next.push({ id: note.id, text: note.text, x: p.x, y: p.y });
        }
      }
      const changed = next.length !== published.current.length
        || next.some((n, i) => n.id !== published.current[i].id
          || Math.abs(n.x - published.current[i].x) > EPSILON
          || Math.abs(n.y - published.current[i].y) > EPSILON);
      if (changed) {
        published.current = next;
        setPins(next);
      }
      raf.current = requestAnimationFrame(onFrame);
    };
    raf.current = requestAnimationFrame(onFrame);
    return () => cancelAnimationFrame(raf.current);
  }, [annotations]);

  // Take the tap while annotating.
  useEffect(() => {
    if (!annotating) { setDraft(undefined); return; }
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      // The HUD, the sheets and the composer keep their own clicks.
      if (target instanceof Element && target.closest('button, input, textarea, .ar-sheet, .panel, .note-compose, .note-pin')) return;
      const manager = getActiveManager();
      const hit = manager?.pickAnnotationAtClient(event.clientX, event.clientY);
      if (!hit) {
        // Not an error — a miss. The AR error banner is for AR refusing to
        // start; using it here would teach operators to dismiss it unread.
        setDraft(undefined);
        setMissed(true);
        window.setTimeout(() => setMissed(false), 1600);
        return;
      }
      setMissed(false);
      const part = useStore.getState().assembly.parts.find((p) => p.id === hit.partId);
      setText('');
      setDraft({ partId: hit.partId, local: hit.local, part: part?.name ?? hit.partId });
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [annotating]);

  useEffect(() => { if (draft) input.current?.focus(); }, [draft]);

  if (annotations.length === 0 && !annotating) return null;

  const save = (): void => {
    if (!draft || !text.trim()) return;
    addAnnotation(draft.partId, draft.local, text);
    setDraft(undefined);
    setText('');
  };

  return (
    <>
      <div className="annotations">
        {pins.map((pin) => (
          <button
            key={pin.id}
            className={`note-pin ${openId === pin.id ? 'open' : ''}`}
            style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
            onClick={() => setOpenId(openId === pin.id ? undefined : pin.id)}
          >
            <span className="note-dot" aria-hidden>✎</span>
            <span className="note-text">{pin.text}</span>
            {openId === pin.id && (
              <span
                className="note-delete"
                role="button"
                tabIndex={0}
                aria-label="Delete note"
                onClick={(e) => { e.stopPropagation(); removeAnnotation(pin.id); setOpenId(undefined); }}
              >✕</span>
            )}
          </button>
        ))}
      </div>

      {annotating && !draft && (
        <p className={`note-hint ${missed ? 'missed' : ''}`} role="status">
          {missed ? 'Nothing there — aim at a part' : 'Tap a part to note something about it'}
        </p>
      )}

      {draft && (
        <div className="note-compose" role="dialog" aria-label={`Note on ${draft.part}`}>
          <strong>{draft.part}</strong>
          <input
            ref={input}
            value={text}
            maxLength={280}
            placeholder="What should the next person know?"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setDraft(undefined); }}
          />
          <div className="note-actions">
            <button className="ghost" onClick={() => setDraft(undefined)}>Cancel</button>
            <button className="primary" disabled={!text.trim()} onClick={save}>Add note</button>
          </div>
        </div>
      )}
    </>
  );
}
