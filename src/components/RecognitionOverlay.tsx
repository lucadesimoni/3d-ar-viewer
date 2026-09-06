import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { STATUS_COLORS, VERDICT_COLORS } from '../vision/verdict';
import { useUiConfig } from '../ui/UiConfigContext';

/**
 * Colour-coded discrepancy shown *on the affected part*.
 *
 * The 3D overlay is registered to the real workpiece, so tinting the affected
 * virtual part (done in the SceneManager) tints the real part's area. This
 * component adds the small labels that ride on top of each affected part: it
 * projects the part's position to screen space every frame and pins a compact
 * tag there — no free-floating boxes over unrelated regions of the frame. Only
 * recognised objects that map to a known assembly part get a marker; anything
 * unrecognised is left to the verdict banner alone.
 */

interface Tag {
  id: number;
  label: string;
  status: keyof typeof STATUS_COLORS;
  score: number;
  x: number;
  y: number;
}

export function RecognitionOverlay(): JSX.Element | null {
  const recognition = useStore((s) => s.recognition);
  const assembly = useStore((s) => s.assembly);
  const [tags, setTags] = useState<Tag[]>([]);
  const rafRef = useRef(0);
  // In AR the banner is rendered inside the HUD stack instead (see ArHud), so
  // it can never end up behind the control bar that owns the bottom edge.
  const inAr = useStore((s) => s.arSource) !== undefined;
  const showBanner = useUiConfig().showRecognitionBanner && !inAr;

  // Project each affected part to screen space every frame so the tag tracks it.
  useEffect(() => {
    if (!recognition) { setTags([]); return; }
    const partIds = new Set(assembly.parts.map((p) => p.id));
    const onFrame = (): void => {
      const manager = getActiveManager();
      const next: Tag[] = [];
      if (manager) {
        for (const o of recognition.objects) {
          if (!partIds.has(o.label)) continue; // only on known assembly parts
          const p = manager.projectPart(o.label);
          if (!p || !p.onScreen) continue;
          next.push({ id: o.id, label: o.name ?? o.label, status: o.status, score: o.score, x: p.x, y: p.y });
        }
      }
      setTags(next);
      rafRef.current = requestAnimationFrame(onFrame);
    };
    rafRef.current = requestAnimationFrame(onFrame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [recognition, assembly]);

  if (!recognition) return null;

  return (
    <>
      <div className="recognition-tags">
        {tags.map((t) => (
          <span
            key={t.id}
            className={`reco-pin ${t.status}`}
            style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%`, borderColor: STATUS_COLORS[t.status], color: STATUS_COLORS[t.status] }}
          >
            {t.status === 'match' ? '✓' : t.status === 'mismatch' ? '✕' : '?'} {t.label} · {Math.round(t.score * 100)}%
          </span>
        ))}
      </div>
      {showBanner && <VerdictBanner />}
    </>
  );
}

export function VerdictBanner(): JSX.Element | null {
  const recognition = useStore((s) => s.recognition);
  const assembly = useStore((s) => s.assembly);
  if (!recognition) return null;

  const color = VERDICT_COLORS[recognition.verdict];
  const expectedNames = recognition.expectedLabels
    .map((id) => assembly.parts.find((p) => p.id === id)?.name ?? id)
    .join(', ');

  let text: string;
  if (recognition.verdict === 'correct') text = `Correct part in view — ${expectedNames}`;
  else if (recognition.verdict === 'wrong') text = `Wrong part: ${recognition.wrongName ?? recognition.wrongLabel} — expected ${expectedNames}`;
  else text = `Looking for ${expectedNames}…`;

  return (
    <div className="recognition-banner" style={{ borderColor: color, color }}>
      <span className="reco-dot" style={{ background: color }} />
      <span className="reco-text">{text}</span>
    </div>
  );
}
