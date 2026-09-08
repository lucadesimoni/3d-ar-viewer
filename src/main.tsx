import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import { trackVisibleHeight } from './ui/visibleHeight';
import { useStore } from './state/store';
import { parseUiConfigFromParams } from './ui/config';
import { ASSEMBLIES } from './data';
import { getActiveManager } from './render/babylon/managerRegistry';
import { installEmbedBridge } from './embed/bridge';

// Config for the standalone/iframe build comes from URL params, e.g.
//   /?ui=minimal&embedded=1&accent=%23ff7a00
const config = parseUiConfigFromParams(typeof window !== 'undefined' ? window.location.search : '');

// `?assembly=kallax-4x4` opens straight into one sample — the phone is where
// this gets tested, and typing a URL beats hunting through a picker in AR.
const wanted = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('assembly');
const chosen = wanted ? ASSEMBLIES.find((a) => a.id === wanted || a.name.toLowerCase().includes(wanted.toLowerCase())) : undefined;
if (chosen) useStore.getState().loadAssembly(chosen);

// `?step=<id>` resumes where the operator was.
//
// This is the hand-off to iOS: an iPad's browser has no WebXR, so the way to
// real tracking is an App Clip, and a clip is a separate browsing context —
// nothing but the address carries across. Landing back on step one of a
// fourteen-bay rack because you asked for better tracking is the kind of small
// insult that stops people using the better thing.
const step = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('step');
if (step) {
  const assembly = useStore.getState().assembly;
  if (assembly.steps.some((s) => s.id === step)) useStore.getState().setActiveStep(step);
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App config={config} /></StrictMode>);

// Expose the store and the live scene for demo/e2e driving (read-only handles).
(window as unknown as { spatialStore?: typeof useStore }).spatialStore = useStore;
(window as unknown as { spatialScene?: typeof getActiveManager }).spatialScene = getActiveManager;

const parentOrigin = new URLSearchParams(window.location.search).get('parentOrigin');
if (parentOrigin && window.parent !== window) {
  try {
    const disposeBridge = installEmbedBridge(parentOrigin);
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) disposeBridge();
    });
    import.meta.hot?.dispose(disposeBridge);
  } catch (error) {
    console.error('Viewer host integration could not start', error);
    useStore.getState().setArError('Host integration is unavailable: parentOrigin must be an exact HTTP(S) origin.');
  }
}

// Register the offline app-shell service worker in production (secure contexts
// only; skipped in dev and where unsupported).
if ('serviceWorker' in navigator && window.isSecureContext && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

// The app is exactly as tall as what the operator can see — measured, not
// assumed from `100dvh`. See the module for the two devices that disagreed.
trackVisibleHeight();
