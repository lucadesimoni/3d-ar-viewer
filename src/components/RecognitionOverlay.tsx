import { useStore } from '../state/store';
import { STATUS_COLORS, VERDICT_COLORS } from '../vision/verdict';

/**
 * Colour-coded discrepancy overlay for recognised objects.
 *
 * Draws a box around every confirmed detection in the camera frame, coloured by
 * whether it is the part the current step expects (green), a different known
 * part — a wrong pick (red), or something unrecognised (amber). A banner sums it
 * up in words. This is the "recognised → coloured discrepancy" surface: the
 * operator sees, live, whether what they are holding is right.
 *
 * Boxes are normalised (0..1) in the camera frame and drawn in an SVG that
 * stretches over the viewport, so they track the passthrough behind the canvas.
 */
export function RecognitionOverlay(): JSX.Element | null {
  const recognition = useStore((s) => s.recognition);
  if (!recognition || recognition.objects.length === 0) {
    return recognition ? <VerdictBanner /> : null;
  }

  return (
    <>
      <svg className="recognition-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {recognition.objects.map((o) => {
          const color = STATUS_COLORS[o.status];
          const x = o.box.x * 100;
          const y = o.box.y * 100;
          const w = o.box.w * 100;
          const h = o.box.h * 100;
          return (
            <g key={o.id}>
              <rect
                x={x} y={y} width={w} height={h}
                fill={color} fillOpacity={0.12}
                stroke={color} strokeWidth={0.5}
                rx={1}
              />
              {/* Corner ticks read as a "recognised" reticle, not just a box. */}
              <path
                d={`M${x},${y + 4} V${y} H${x + 4} M${x + w - 4},${y} H${x + w} V${y + 4} M${x + w},${y + h - 4} V${y + h} H${x + w - 4} M${x + 4},${y + h} H${x} V${y + h - 4}`}
                fill="none" stroke={color} strokeWidth={0.9}
              />
            </g>
          );
        })}
      </svg>
      {/* Labels in a non-scaled layer so text stays crisp regardless of aspect. */}
      <div className="recognition-labels">
        {recognition.objects.map((o) => (
          <span
            key={o.id}
            className={`reco-tag ${o.status}`}
            style={{
              left: `${(o.box.x + o.box.w / 2) * 100}%`,
              top: `${o.box.y * 100}%`,
              borderColor: STATUS_COLORS[o.status],
              color: STATUS_COLORS[o.status],
            }}
          >
            {o.status === 'match' ? '✓' : o.status === 'mismatch' ? '✕' : '?'}{' '}
            {o.name ?? o.label} · {Math.round(o.score * 100)}%
          </span>
        ))}
      </div>
      <VerdictBanner />
    </>
  );
}

function VerdictBanner(): JSX.Element | null {
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
      {text}
    </div>
  );
}
