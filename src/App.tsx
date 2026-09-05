import { useMemo, useRef, useState } from 'react';
import { Viewer } from './components/Viewer';
import { StatusBar } from './components/StatusBar';
import { StepGuide } from './components/StepGuide';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { ModeBar } from './components/ModeBar';
import { RegistrationPanel } from './components/RegistrationPanel';
import { InspectorPanel } from './components/InspectorPanel';
import { CollabPanel } from './components/CollabPanel';
import { BomPanel } from './components/BomPanel';
import { useArController } from './components/useArController';
import { QuickLookButton } from './components/QuickLookButton';
import { RecognitionOverlay } from './components/RecognitionOverlay';
import { UiConfigProvider } from './ui/UiConfigContext';
import { resolveUiConfig, type UiConfig } from './ui/config';
import { useMediaQuery } from './ui/useMediaQuery';

type Drawer = 'register' | 'collab' | 'bom' | undefined;

/**
 * Application shell. Its layout flexes from a full workstation down to a bare
 * embeddable viewer, driven entirely by the resolved `UiConfig`: each panel is
 * rendered only when its flag is on, and the root carries variant classes so the
 * CSS can adapt the grid, chrome, and density. Passing `config` (from a React
 * host such as the Mendix widget, or parsed from URL params) is all it takes to
 * reshape the UI — there is no separate embed build.
 */
export function App({ config }: { config?: Partial<UiConfig> }): JSX.Element {
  const ui = useMemo(() => resolveUiConfig(config), [config]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { capabilities, pipelineStatus, arActive, enterAr } = useArController(videoRef);
  const [drawer, setDrawer] = useState<Drawer>(undefined);
  // On a phone/tablet the three-column desktop layout does not fit: the viewport
  // is the app, and the panels live in a collapsible sheet with one visible at a
  // time. In AR the sheet starts collapsed so nothing covers the camera.
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [sheet, setSheet] = useState<'steps' | 'errors' | null>('steps');
  const mobileSheet = arActive ? null : sheet;

  const rootClass = [
    'app',
    arActive ? 'ar' : '',
    ui.embedded ? 'embedded' : '',
    `density-${ui.density}`,
    `preset-${ui.preset}`,
    ui.showSteps ? '' : 'no-left',
    ui.showDiagnostics ? '' : 'no-right',
    isMobile ? 'mobile' : '',
    isMobile && mobileSheet === null ? 'sheet-collapsed' : '',
  ].filter(Boolean).join(' ');

  const accentStyle = ui.accent ? ({ ['--accent' as string]: ui.accent, ['--accent-2' as string]: ui.accent }) : undefined;

  return (
    <UiConfigProvider value={ui}>
      <div className={rootClass} style={accentStyle}>
        <video ref={videoRef} className="passthrough" playsInline muted />

        {ui.showHeader && (
          <StatusBar capabilities={capabilities} pipeline={pipelineStatus} onEnterAr={enterAr} arActive={arActive} />
        )}
        {ui.showRecognition && <QuickLookButton capabilities={capabilities} />}

        <div className="stage">
          {ui.showSteps && (!isMobile || mobileSheet === 'steps') && <StepGuide />}
          <main className="viewport">
            <Viewer transparent={arActive} />
            {ui.showRecognition && <RecognitionOverlay />}
            <div className="viewport-overlay">
              {ui.showInspector && <InspectorPanel />}
              {ui.showDrawers && (
                <>
                  <div className="drawer-tabs">
                    <button className={drawer === 'register' ? 'active' : ''} onClick={() => setDrawer(drawer === 'register' ? undefined : 'register')}>Register</button>
                    <button className={drawer === 'collab' ? 'active' : ''} onClick={() => setDrawer(drawer === 'collab' ? undefined : 'collab')}>Collaborate</button>
                    <button className={drawer === 'bom' ? 'active' : ''} onClick={() => setDrawer(drawer === 'bom' ? undefined : 'bom')}>BOM</button>
                  </div>
                  {drawer === 'register' && <div className="drawer"><RegistrationPanel /></div>}
                  {drawer === 'collab' && <div className="drawer"><CollabPanel /></div>}
                  {drawer === 'bom' && <div className="drawer"><BomPanel /></div>}
                </>
              )}
              {/* Minimal/viewer layouts still expose AR entry when the header is hidden. */}
              {!ui.showHeader && (
                <button className={`ar-enter floating ${arActive ? 'active' : ''}`} onClick={enterAr}>
                  {arActive ? 'Exit AR' : 'Enter AR'}
                </button>
              )}
            </div>
          </main>
          {ui.showDiagnostics && (!isMobile || mobileSheet === 'errors') && <DiagnosticsPanel />}
          {isMobile && (ui.showSteps || ui.showDiagnostics) && (
            <nav className="sheet-tabs" role="tablist">
              {ui.showSteps && (
                <button role="tab" aria-selected={mobileSheet === 'steps'}
                  className={mobileSheet === 'steps' ? 'active' : ''}
                  onClick={() => setSheet(sheet === 'steps' ? null : 'steps')}>Steps</button>
              )}
              {ui.showDiagnostics && (
                <button role="tab" aria-selected={mobileSheet === 'errors'}
                  className={mobileSheet === 'errors' ? 'active' : ''}
                  onClick={() => setSheet(sheet === 'errors' ? null : 'errors')}>Errors</button>
              )}
              <button className="sheet-collapse" onClick={() => setSheet(null)}
                aria-label="Hide panel">▾</button>
            </nav>
          )}
        </div>

        {ui.showModeBar && <ModeBar />}

        {ui.showHeader && capabilities && capabilities.notes.length > 0 && !arActive && (
          <div className="capability-notes">
            {capabilities.notes.map((n) => <p key={n}>ℹ {n}</p>)}
          </div>
        )}
      </div>
    </UiConfigProvider>
  );
}
