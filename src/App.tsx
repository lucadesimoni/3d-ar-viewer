import { useRef, useState } from 'react';
import { Viewer } from './components/Viewer';
import { StatusBar } from './components/StatusBar';
import { StepGuide } from './components/StepGuide';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { ModeBar } from './components/ModeBar';
import { RegistrationPanel } from './components/RegistrationPanel';
import { InspectorPanel } from './components/InspectorPanel';
import { CollabPanel } from './components/CollabPanel';
import { useArController } from './components/useArController';
import { QuickLookButton } from './components/QuickLookButton';
import { RecognitionOverlay } from './components/RecognitionOverlay';

type Drawer = 'register' | 'collab' | undefined;

/**
 * Application shell. Lays out the persistent panels around the 3D viewer and
 * owns the two device-facing bits of DOM: the passthrough `<video>` that sits
 * behind the transparent canvas in AR, and the AR-entry lifecycle.
 */
export function App(): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { capabilities, pipelineStatus, arActive, enterAr } = useArController(videoRef);
  const [drawer, setDrawer] = useState<Drawer>(undefined);

  return (
    <div className={`app ${arActive ? 'ar' : ''}`}>
      <video ref={videoRef} className="passthrough" playsInline muted />
      <StatusBar capabilities={capabilities} pipeline={pipelineStatus} onEnterAr={enterAr} arActive={arActive} />
      <QuickLookButton capabilities={capabilities} />

      <div className="stage">
        <StepGuide />
        <main className="viewport">
          <Viewer transparent={arActive} />
          <RecognitionOverlay />
          <div className="viewport-overlay">
            <InspectorPanel />
            <div className="drawer-tabs">
              <button className={drawer === 'register' ? 'active' : ''} onClick={() => setDrawer(drawer === 'register' ? undefined : 'register')}>Register</button>
              <button className={drawer === 'collab' ? 'active' : ''} onClick={() => setDrawer(drawer === 'collab' ? undefined : 'collab')}>Collaborate</button>
            </div>
            {drawer === 'register' && <div className="drawer"><RegistrationPanel /></div>}
            {drawer === 'collab' && <div className="drawer"><CollabPanel /></div>}
          </div>
        </main>
        <DiagnosticsPanel />
      </div>

      <ModeBar />

      {capabilities && capabilities.notes.length > 0 && !arActive && (
        <div className="capability-notes">
          {capabilities.notes.map((n) => <p key={n}>ℹ {n}</p>)}
        </div>
      )}
    </div>
  );
}
