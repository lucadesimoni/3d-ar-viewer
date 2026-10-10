import { useEffect } from 'react';
import { useStore } from '../state/store';
import type { EligibilityReason } from '../perception/eligibility';
import { ASSEMBLIES } from '../data';
import { useUiConfig } from '../ui/UiConfigContext';
import { useScrollOverflow } from '../ui/useScrollOverflow';
import { useStepPreview } from './useStepPreview';
import { activateOnKey } from '../ui/keys';
import { revealOffset } from '../ui/reveal';
import { prefersReducedMotion } from '../ui/motion';

/** Left rail: the ordered build steps with live status, and the active card. */
export function StepGuide(): JSX.Element {
  const assembly = useStore((s) => s.assembly);
  const sequence = useStore((s) => s.sequence);
  const activeStepId = useStore((s) => s.activeStepId);
  const setActiveStep = useStore((s) => s.setActiveStep);
  const completeStep = useStore((s) => s.completeStep);
  const reopenStep = useStore((s) => s.reopenStep);
  const preview = useStepPreview();
  const placeStep = useStore((s) => s.placeActiveStepFromStandoff);
  const ui = useUiConfig();

  const active = sequence.steps.find((s) => s.step.id === activeStepId);
  const stepNumber = (id: string): number => sequence.steps.findIndex((s) => s.step.id === id) + 1;
  const firstBlocking = (ids: string[]): string =>
    ids.reduce((a, b) => (stepNumber(b) < stepNumber(a) ? b : a));
  const remaining = Math.round(sequence.remainingS / 60);

  // The card that most needs to fit is the one a short phone's 38dvh panel
  // cannot always hold — a caution line, tools, and three buttons can run
  // past it, and the card scrolls internally rather than losing the "Sign
  // off" button under the tab bar (see the mobile rule for `.active-card`).
  // A box that clips and just stops looks identical to one that is broken;
  // this says, measured rather than guessed, whether there is more to see.
  const { ref: cardRef, hasMore } = useScrollOverflow<HTMLDivElement>('y', [active?.step.id]);

  // The same question, sideways: the step strip starts at step 1, and on a
  // 46-step assembly only the first handful of numbered circles fit. Nothing
  // said the rest were a swipe away rather than simply not there.
  const { ref: stepListRef, hasMore: moreSteps, hasLess: earlierSteps } =
    useScrollOverflow<HTMLOListElement>('x', [assembly.id]);

  // And the strip follows the active step. Advanced from the AR bar, or by
  // signing off, the active step walked off the strip's right edge: on a
  // phone, step 12's chip sat 110 px past it, so the strip no longer said
  // where you were.
  useEffect(() => {
    const list = stepListRef.current;
    const item = list?.querySelector<HTMLElement>('.step-row.selected');
    if (!list || !item) return;
    const l = list.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
    if (list.scrollWidth > list.clientWidth + 1) {
      const left = revealOffset(list.scrollLeft, list.clientWidth, r.left - l.left + list.scrollLeft, r.width);
      if (left !== undefined) list.scrollTo?.({ left, behavior });
    } else if (list.scrollHeight > list.clientHeight + 1) {
      const top = revealOffset(list.scrollTop, list.clientHeight, r.top - l.top + list.scrollTop, r.height);
      if (top !== undefined) list.scrollTo?.({ top, behavior });
    }
  }, [activeStepId, assembly.id, stepListRef]);

  return (
    <aside className="panel step-guide">
      <header className="panel-head">
        <div className="panel-ident">
          {ui.showAssemblyPicker ? (
            <select
              className="assembly-picker"
              value={assembly.id}
              // The closed control clips a long name with no ellipsis and no
              // other way to read the rest of it — `title` is the cheap,
              // native way to still get it, on any device that hovers or
              // long-presses.
              title={assembly.name}
              onChange={(e) => {
                const next = ASSEMBLIES.find((a) => a.id === e.target.value);
                if (next) useStore.getState().loadAssembly(next);
              }}
            >
              {ASSEMBLIES.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          ) : (
            <h2>{assembly.name}</h2>
          )}
          <span className="rev">Rev {assembly.revision} · {assembly.parts.length} parts</span>
        </div>
        <div className="progress-ring" role="progressbar" aria-label="Assembly progress"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sequence.progress * 100)} style={{ ["--p" as string]: Math.round(sequence.progress * 100) }}>
          {Math.round(sequence.progress * 100)}%
        </div>
      </header>

      <div className={`step-list-wrap ${moreSteps ? 'has-more' : ''} ${earlierSteps ? 'has-less' : ''}`}>
        <ol className="step-list" ref={stepListRef}>
          {sequence.steps.map((s, i) => (
            <li
              key={s.step.id}
              className={`step-row ${s.status} ${s.step.id === activeStepId ? 'selected' : ''}`}
              onClick={() => setActiveStep(s.step.id)}
              // Reachable without a pointer, and saying which one is current.
              tabIndex={0}
              onKeyDown={(e) => activateOnKey(e, () => setActiveStep(s.step.id))}
              aria-current={s.step.id === activeStepId ? 'step' : undefined}
            >
              <span className={`bullet ${s.status}`}>{i + 1}</span>
              <span className="step-title">{s.step.title}</span>
              <span className={`chip ${s.status}`}>{s.status}</span>
            </li>
          ))}
        </ol>
        {/* Desktop shows the full titled list already — nothing to hide from
            here, and the rule below only paints the strip on mobile anyway. */}
        {earlierSteps && <span className="scroll-more left" aria-hidden="true">‹</span>}
        {moreSteps && <span className="scroll-more right" aria-hidden="true">›</span>}
      </div>

      {active && (
        <div className="active-card-wrap">
          {/* Only the text scrolls. The actions sat inside the scroller, and on
              a phone the card is short: the buttons scrolled away with the text,
              came out clipped, and the "More" badge sat on top of them. */}
          <div className={`active-card-scroll ${hasMore ? 'has-more' : ''}`}>
            <div className="active-card" ref={cardRef}>
              {active.step.caution && <p className="caution">⚠ {active.step.caution}</p>}
              {/* Where you are in the job. On a phone the step list is a strip
                  of numbers, so the card has to say this itself — "Mount base
                  plate" alone does not tell you whether five minutes or an hour
                  is left. */}
              <span className="active-count">
                Step {sequence.steps.findIndex((s) => s.step.id === active.step.id) + 1} of {sequence.steps.length}
              </span>
              <h3>{active.step.title}</h3>
              <p className="instruction">{active.step.instruction}</p>
              {active.step.toolIds && active.step.toolIds.length > 0 && (
                <p className="tools">
                  Tools:{' '}
                  {active.step.toolIds
                    .map((id) => assembly.tools?.find((t) => t.id === id)?.name ?? id)
                    .join(', ')}
                </p>
              )}
              <PresenceList partIds={active.step.partIds} />
            </div>
            {/* Only rendered when the card is actually short of room — a
                permanent hint on a card that always fits would be noise. */}
            {hasMore && <span className="scroll-more down" aria-hidden="true">More ↓</span>}
          </div>
          {/* Why "Sign off" is greyed out, next to it and not inside the
              scrolling card: on a phone the card's last line is under the
              "More" badge, and the button looked broken. With the way out. */}
          {active.blockedBy.length > 0 ? (
            <p className="blocked" role="status">
              Waiting on step{active.blockedBy.length > 1 ? 's' : ''}{' '}
              {active.blockedBy.map((id) => stepNumber(id)).sort((a, b) => a - b).join(', ')}.{' '}
              <button className="link" onClick={() => setActiveStep(firstBlocking(active.blockedBy))}>
                Go to step {Math.min(...active.blockedBy.map(stepNumber))}
              </button>
            </p>
          ) : active.status === 'error' ? (
            <p className="blocked" role="status">Clear this step's errors before signing it off.</p>
          ) : null}
          <div className="active-actions">
            <button className="ghost" onClick={preview.play}>▶ Show me</button>
            <button className="secondary" onClick={placeStep}>⤓ Place</button>
            {active.status === 'complete' ? (
              <button className="secondary" onClick={() => reopenStep(active.step.id)}>Re-open</button>
            ) : (
              <button
                className="primary"
                disabled={active.status === 'error' || active.blockedBy.length > 0}
                onClick={() => completeStep(active.step.id)}
              >
                Sign off
              </button>
            )}
          </div>
        </div>
      )}

      <footer className="est">≈ {remaining} min of work left</footer>
    </aside>
  );
}

const REASON_TEXT: Record<EligibilityReason, string> = {
  'no-target': 'nothing to recognise',
  'no-anchor': 'not placed yet',
  clipped: 'not fully in view',
  'too-small': 'too small in the picture',
  'too-far': 'too far away',
  blurry: 'picture blurry, hold still',
  'not-settled': 'tracking still settling',
  exploded: 'exploded view is on',
  occluded: 'hidden behind a fitted part',
  'blank-frame': 'no camera picture',
};

/**
 * What the camera can see of this step's parts — a suggestion, never a
 * sign-off. Only there while a recognition target is anchored in AR; a purely
 * virtual assembly has nothing real to look for.
 */
function PresenceList({ partIds }: { partIds: string[] }): JSX.Element | null {
  const presence = useStore((s) => s.partPresence);
  const parts = useStore((s) => s.assembly.parts);
  const shown = partIds.filter((id) => presence[id]);
  if (shown.length === 0) return null;
  return (
    <ul className="presence" aria-label="What the camera sees" aria-live="polite">
      {shown.map((id) => {
        const p = presence[id];
        const name = parts.find((part) => part.id === id)?.name ?? id;
        const text = p.state === 'present' ? 'seen'
          : p.state === 'absent' ? 'not seen'
            : p.reasons.length ? `can't check: ${REASON_TEXT[p.reasons[0]]}` : 'checking';
        return <li key={id} className={`presence-${p.state}`}>{name} — {text}</li>;
      })}
    </ul>
  );
}
