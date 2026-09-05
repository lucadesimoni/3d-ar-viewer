import { useState } from 'react';
import { useStore } from '../state/store';
import { StepGuide } from './StepGuide';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ModeBar } from './ModeBar';
import { ArSettings } from './ArSettings';
import type { Capabilities } from '../engine/tracking/capabilities';

type Sheet = 'steps' | 'errors' | 'view' | 'settings' | null;

/**
 * The only chrome that belongs on screen in AR on a phone or tablet.
 *
 * In AR the camera image *is* the interface, so the desktop layout — a header,
 * two side panels and a mode bar — is exactly wrong: it eats two thirds of an
 * iPad's screen and puts the controls in the corners, which on a tablet held in
 * two hands is the hardest place to reach. This is a single thumb-height bar
 * over the live view, with the panels one tap away in a sheet that covers less
 * than half the screen and can be dismissed by tapping the same button again.
 *
 * Everything here is at least 48 px tall, which is the smallest target a gloved
 * finger reliably hits on a workshop tablet.
 */
export function ArHud({ onExit, onReplace, capabilities }: {
  onExit: () => void;
  onReplace: () => void;
  capabilities?: Capabilities;
}): JSX.Element {
  const [sheet, setSheet] = useState<Sheet>(null);
  const assembly = useStore((s) => s.assembly);
  const activeStepId = useStore((s) => s.activeStepId);
  const setActiveStep = useStore((s) => s.setActiveStep);
  const diagnostics = useStore((s) => s.diagnostics);
  const completed = useStore((s) => s.completedStepIds);

  const index = assembly.steps.findIndex((s) => s.id === activeStepId);
  const step = index >= 0 ? assembly.steps[index] : undefined;
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const toggle = (s: Sheet) => setSheet((cur) => (cur === s ? null : s));
  const go = (delta: number) => {
    const next = assembly.steps[index + delta];
    if (next) setActiveStep(next.id);
  };

  return (
    <div className="ar-hud">
      {sheet && (
        <div className="ar-sheet" role="dialog" aria-label={sheet}>
          {sheet === 'steps' && <StepGuide />}
          {sheet === 'errors' && <DiagnosticsPanel />}
          {sheet === 'view' && <ModeBar />}
          {sheet === 'settings' && <ArSettings capabilities={capabilities} />}
        </div>
      )}

      {/* Current step, always visible: in AR the operator should never have to
          open a panel to know what they are fitting. */}
      <div className="ar-now">
        <button className="ar-step-nav" onClick={() => go(-1)} disabled={index <= 0} aria-label="Previous step">‹</button>
        <div className="ar-now-text">
          <span className="ar-now-count">{index + 1}/{assembly.steps.length} · {completed.size} done</span>
          <strong>{step?.title ?? assembly.name}</strong>
        </div>
        <button className="ar-step-nav" onClick={() => go(1)} disabled={index >= assembly.steps.length - 1} aria-label="Next step">›</button>
      </div>

      <div className="ar-bar" role="toolbar" aria-label="AR controls">
        <button className={`ar-btn ${sheet === 'steps' ? 'active' : ''}`} onClick={() => toggle('steps')}>
          <span className="ar-btn-icon">☰</span>Steps
        </button>
        <button className={`ar-btn ${sheet === 'errors' ? 'active' : ''} ${errors ? 'alert' : ''}`} onClick={() => toggle('errors')}>
          <span className="ar-btn-icon">⚠</span>Errors{errors > 0 && <span className="ar-count">{errors}</span>}
        </button>
        <button className={`ar-btn ${sheet === 'view' ? 'active' : ''}`} onClick={() => toggle('view')}>
          <span className="ar-btn-icon">❋</span>View
        </button>
        <button className="ar-btn" onClick={() => { setSheet(null); onReplace(); }}>
          <span className="ar-btn-icon">◎</span>Move
        </button>
        <button
          className={`ar-btn ${sheet === 'settings' ? 'active' : ''}`}
          onClick={() => toggle('settings')}
          aria-label="AR settings"
        >
          <span className="ar-btn-icon">⚙</span>Settings
        </button>
        <button className="ar-btn danger" onClick={onExit}>
          <span className="ar-btn-icon">✕</span>Exit
        </button>
      </div>
    </div>
  );
}
