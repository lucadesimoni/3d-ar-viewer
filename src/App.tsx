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
import { AppClipLink } from './components/AppClipLink';
import { RecognitionOverlay } from './components/RecognitionOverlay';
import { PlacementHint } from './components/PlacementHint';
import { StepAnnotations } from './components/StepAnnotations';
import { Annotations } from './components/Annotations';
import { ArHud } from './components/ArHud';
import { DiagnosticsExport } from './components/DiagnosticsExport';
import { UiConfigProvider } from './ui/UiConfigContext';
import { resolveUiConfig, type UiConfig } from './ui/config';
import { useMediaQuery } from './ui/useMediaQuery';
import { useStore } from './state/store';
import type { PipelineConfig } from './vision/pipeline';

type Drawer = 'register' | 'collab' | 'bom' | 'log' | undefined;
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

export function App({ config, recognitionConfig }: { config?: Partial<UiConfig>; recognitionConfig?: PipelineConfig }): JSX.Element {
  const ui = useMemo(() => resolveUiConfig(config), [config]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { capabilities, pipelineStatus, arActive, enterAr, replaceAnchor, bringInFront, retryWebXr } =
    useArController(videoRef, recognitionConfig);
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

  // A second, independent way to keep the page's own surfaces out of the
  // compositor's way. The session helper marks the overlay root too, but that
  // depends on Babylon's session observer firing and on my CSS being right;
  // this one is React state, and in a WebXR session there is no camera video at
  // all — the compositor supplies the image.
  const xrSource = useStore((st) => st.arSource) === 'webxr';
  const rootClass = [
    'app',
    arActive ? 'ar' : '',
    arActive && xrSource ? 'xr' : '',
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
        {/* On iOS this is the only route to positional tracking; it belongs
            next to the way into AR, not buried in a settings sheet. */}
        {!arActive && <AppClipLink capabilities={capabilities} />}

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
          {/* A handle that says the sheet can be got out of the way.
              Tapping the active tab already collapsed it — nothing on screen
              said so, and a tester asked for a way to focus the 3D view that
              was there all along. An affordance, not a feature. */}
          {isMobile && !arActive && mobileSheet !== null && (
            <button
              className="sheet-handle"
              aria-label="Collapse the panel and show the 3D view"
              onClick={() => setSheet(null)}
            >
              <span aria-hidden="true">⌄</span>
            </button>
          )}
          {ui.showSteps && !arActive && (!isMobile || mobileSheet === 'steps') && <StepGuide />}
          <main className="viewport">
            <Viewer transparent={arActive} />
            {ui.showSteps && <StepAnnotations />}
            {/* Operator notes ride the parts, in the studio and in AR alike. */}
            <Annotations />
            {ui.showRecognition && <RecognitionOverlay />}
            {arActive && <PlacementHint />}
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
                    <button className={drawer === 'log' ? 'active' : ''} onClick={() => setDrawer(drawer === 'log' ? undefined : 'log')}>Log</button>
                  </div>
                  {drawer === 'register' && <div className="drawer"><RegistrationPanel /></div>}
                  {drawer === 'collab' && <div className="drawer"><CollabPanel /></div>}
                  {drawer === 'bom' && <div className="drawer"><BomPanel /></div>}
                  {drawer === 'log' && (
                    <div className="drawer"><DiagnosticsExport capabilities={capabilities} /></div>
                  )}
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
                {/* Reachable without entering AR, and without the AR bar, which
                    on an iPad inside the App Clip has been seen not to appear.
                    A log you can only reach through missing chrome is a log
                    nobody can send. */}
                <button className={drawer === 'log' ? 'active' : ''} onClick={() => setDrawer('log')}>Log</button>
              </div>
              {drawer === 'collab' ? <CollabPanel />
                : drawer === 'bom' ? <BomPanel />
                  : drawer === 'log' ? <DiagnosticsExport capabilities={capabilities} />
                    : <RegistrationPanel />}
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
        {arActive && <ArHud
            onExit={enterAr} onReplace={replaceAnchor} onBringInFront={bringInFront}
            onRetryWebXr={retryWebXr}
            capabilities={capabilities} pipeline={pipelineStatus}
          />}

      </div>
    </UiConfigProvider>
  );
}
