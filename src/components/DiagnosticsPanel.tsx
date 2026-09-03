import { useStore } from '../state/store';
import type { Diagnostic } from '../engine/diagnostics';

const ICON: Record<Diagnostic['severity'], string> = { error: '✕', warning: '!', info: 'i' };

/**
 * Right rail: the live fault list. This is the heart of the "snapping error
 * detection" — every geometric, sequence, interference and swap problem the
 * engine finds, ranked worst-first, each tappable to select the offending part.
 */
export function DiagnosticsPanel(): JSX.Element {
  const diagnostics = useStore((s) => s.diagnostics);
  const selectPart = useStore((s) => s.selectPart);
  const selectedPartId = useStore((s) => s.selectedPartId);

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;

  return (
    <aside className="panel diagnostics">
      <header className="panel-head">
        <h2>Fit &amp; error check</h2>
        <div className="counts">
          <span className="count error">{errors}</span>
          <span className="count warning">{warnings}</span>
        </div>
      </header>

      {diagnostics.length === 0 ? (
        <p className="all-clear">✓ All placed parts are within tolerance and in sequence.</p>
      ) : (
        <ul className="diag-list">
          {diagnostics.map((d) => (
            <li
              key={d.id}
              className={`diag ${d.severity} ${d.partIds.includes(selectedPartId ?? '') ? 'selected' : ''}`}
              onClick={() => selectPart(d.partIds[0])}
            >
              <span className={`sev ${d.severity}`}>{ICON[d.severity]}</span>
              <div className="diag-body">
                <p className="diag-msg">{d.message}</p>
                {d.detail && <p className="diag-detail">{d.detail}</p>}
                {d.fix && <p className="diag-fix">→ {d.fix}</p>}
              </div>
              <span className="diag-code">{d.code}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
