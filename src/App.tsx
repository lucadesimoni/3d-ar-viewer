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
import { PlacementHint } from './components/PlacementHint';
import { StepAnnotations } from './components/StepAnnotations';
import { ArHud } from './components/ArHud';
import { UiConfigProvider } from './ui/UiConfigContext';
import { resolveUiConfig, type UiConfig } from './ui/config';
import { useMediaQuery } from './ui/useMediaQuery';
import { useStore } from './state/store';

type Drawer = 'register' | 'collab' | 'bom' | undefined;
/** What the phone's bottom sheet is showing. */
type Sheet = 'steps' | 'errors' | 'view' | 'more' | null;

/**
 * Application shell. Its layout flexes from a full workstation down to a bare
 * embeddable viewer, driven entirely by the resolved `UiConfig`: each panel is
 * rendered only when its flag is on, and the root carries variant classes so the
 * CSS can adapt the grid, chrome, and density. Passing `config` (from a React
 * host such as the Mendix widget, or parsed from URL params) is all it takes to
 * reshape the UI — there is no separate embed build.
 */
/** One tab in the phone's bottom bar. Tapping the open one closes the sheet. */
function SheetTab({ id, current, onPick, label, icon, count }: {
  id: Exclude<Sheet, null>;
  current: Sheet;
  onPick: (s: Sheet) => void;
  label: string;
  icon: string;
  count?: number;
}): JSX.Element {
  const active = current === id;
  return (
    <button
      role="tab" aria-selected={active} className={active ? 'active' : ''}
      onClick={() => onPick(active ? null : id)}
    >
      <span className="sheet-tab-icon" aria-hidden="true">{icon}</span>
      {label}
      {count ? <span className="sheet-tab-count">{count}</span> : null}
    </button>
  );
}

export function App({ config }: { config?: Partial<UiConfig> }): JSX.Element {
  const ui = useMemo(() => resolveUiConfig(config), [config]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { capabilities, pipelineStatus, arActive, enterAr, replaceAnchor } = useArController(videoRef);
  const [drawer, setDrawer] = useState<Drawer>(undefined);
  // On a phone/tablet the three-column desktop layout does not fit: the viewport
  // is the app, and the panels live in a collapsible sheet with one visible at a
  // time. In AR the sheet starts collapsed so nothing covers the camera.
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const errorCount = useStore((s) => s.diagnostics.filter((d) => d.severity === 'error').length);
  const arError = useStore((s) => s.arError);
  const [sheet, setSheet] = useState<Sheet>('steps');
  const [notesOpen, setNotesOpen] = useState(true);
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

        {ui.showHeader && !arActive && (
          <StatusBar capabilities={capabilities} pipeline={pipelineStatus} onEnterAr={enterAr}
            arActive={arActive} showEnterAr={!isMobile} />
        )}
        {ui.showRecognition && !arActive && <QuickLookButton capabilities={capabilities} />}

        {/* AR refused to start: say so, on every screen size. */}
        {arError && (
          <div className="ar-error" role="alert">
            <span aria-hidden="true">⚠</span>
            <p>{arError}</p>
            <button className="notes-close" onClick={() => useStore.getState().setArError(undefined)}
              aria-label="Dismiss">✕</button>
          </div>
        )}

        {ui.showHeader && notesOpen && capabilities && capabilities.notes.length > 0 && !arActive && !isMobile && (
          <div className="capability-notes" role="status">
            <button className="notes-close" onClick={() => setNotesOpen(false)} aria-label="Dismiss">✕</button>
            {capabilities.notes.map((n) => <p key={n}>ℹ {n}</p>)}
          </div>
        )}

        <div className="stage">
          {ui.showSteps && !arActive && (!isMobile || mobileSheet === 'steps') && <StepGuide />}
          <main className="viewport">
            <Viewer transparent={arActive} />
            {ui.showSteps && <StepAnnotations />}
            {ui.showRecognition && <RecognitionOverlay />}
            {arActive && <PlacementHint capabilities={capabilities} />}
            <div className="viewport-overlay">
              {ui.showInspector && <InspectorPanel />}
              {/* On a phone these live in the "More" sheet; floating over the
                  viewport they covered the top third of the model. */}
              {ui.showDrawers && !isMobile && !arActive && (
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
              {!ui.showHeader && !isMobile && !arActive && (
                <button className="ar-enter floating" onClick={enterAr}>Enter AR</button>
              )}
            </div>
          </main>
          {ui.showDiagnostics && !arActive && (!isMobile || mobileSheet === 'errors') && <DiagnosticsPanel />}

          {/* A phone gets one sheet, not three stacked bars: the view modes and
              the register/collaborate/BOM drawers live in it too, reached from
              the same row of tabs as the steps and the errors. */}
          {isMobile && !arActive && mobileSheet === 'view' && ui.showModeBar && (
            <div className="panel mobile-sheet"><ModeBar /></div>
          )}
          {isMobile && !arActive && mobileSheet === 'more' && ui.showDrawers && (
            <div className="panel mobile-sheet">
              <div className="drawer-tabs">
                <button className={drawer === 'register' ? 'active' : ''} onClick={() => setDrawer('register')}>Register</button>
                <button className={drawer === 'collab' ? 'active' : ''} onClick={() => setDrawer('collab')}>Collaborate</button>
                <button className={drawer === 'bom' ? 'active' : ''} onClick={() => setDrawer('bom')}>BOM</button>
              </div>
              {drawer === 'collab' ? <CollabPanel /> : drawer === 'bom' ? <BomPanel /> : <RegistrationPanel />}
            </div>
          )}

          {isMobile && !arActive && (
            <nav className="sheet-tabs" role="tablist">
              {ui.showSteps && (
                <SheetTab id="steps" current={mobileSheet} onPick={setSheet} label="Steps" icon="☰" />
              )}
              {ui.showDiagnostics && (
                <SheetTab id="errors" current={mobileSheet} onPick={setSheet} label="Errors" icon="⚠"
                  count={errorCount} />
              )}
              {ui.showModeBar && (
                <SheetTab id="view" current={mobileSheet} onPick={setSheet} label="View" icon="❋" />
              )}
              {ui.showDrawers && (
                <SheetTab id="more" current={mobileSheet} onPick={setSheet} label="More" icon="⋯" />
              )}
              {/* Always last, always there: the way into AR on a phone. */}
              <button className="ar-enter sheet-ar" onClick={enterAr}>
                <span aria-hidden="true">◉</span> Enter AR
              </button>
            </nav>
          )}
        </div>

        {ui.showModeBar && !isMobile && !arActive && <ModeBar />}
        {arActive && <ArHud onExit={enterAr} onReplace={replaceAnchor} capabilities={capabilities} />}

      </div>
    </UiConfigProvider>
  );
}
