import { useStore } from '../state/store';

/** Left rail: the ordered build steps with live status, and the active card. */
export function StepGuide(): JSX.Element {
  const assembly = useStore((s) => s.assembly);
  const sequence = useStore((s) => s.sequence);
  const activeStepId = useStore((s) => s.activeStepId);
  const setActiveStep = useStore((s) => s.setActiveStep);
  const completeStep = useStore((s) => s.completeStep);
  const reopenStep = useStore((s) => s.reopenStep);
  const autoPlace = useStore((s) => s.autoPlaceActiveStep);

  const active = sequence.steps.find((s) => s.step.id === activeStepId);
  const remaining = Math.round(sequence.remainingS / 60);

  return (
    <aside className="panel step-guide">
      <header className="panel-head">
        <div>
          <h2>{assembly.name}</h2>
          <span className="rev">Rev {assembly.revision}</span>
        </div>
        <div className="progress-ring" role="progressbar" aria-valuenow={Math.round(sequence.progress * 100)} style={{ ["--p" as string]: Math.round(sequence.progress * 100) }}>
          {Math.round(sequence.progress * 100)}%
        </div>
      </header>

      <ol className="step-list">
        {sequence.steps.map((s, i) => (
          <li
            key={s.step.id}
            className={`step-row ${s.status} ${s.step.id === activeStepId ? 'selected' : ''}`}
            onClick={() => setActiveStep(s.step.id)}
          >
            <span className={`bullet ${s.status}`}>{i + 1}</span>
            <span className="step-title">{s.step.title}</span>
            <span className={`chip ${s.status}`}>{s.status}</span>
          </li>
        ))}
      </ol>

      {active && (
        <div className="active-card">
          {active.step.caution && <p className="caution">⚠ {active.step.caution}</p>}
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
          {active.blockedBy.length > 0 && (
            <p className="blocked">Blocked until earlier steps are complete.</p>
          )}
          <div className="active-actions">
            <button className="ghost" onClick={autoPlace}>Show me</button>
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
