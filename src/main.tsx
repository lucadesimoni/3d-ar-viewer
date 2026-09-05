import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import { useStore } from './state/store';
import { parseUiConfigFromParams } from './ui/config';
import { ASSEMBLIES } from './data';
import { getActiveManager } from './render/babylon/managerRegistry';

// Config for the standalone/iframe build comes from URL params, e.g.
//   /?ui=minimal&embedded=1&accent=%23ff7a00
const config = parseUiConfigFromParams(typeof window !== 'undefined' ? window.location.search : '');

// `?assembly=kallax-4x4` opens straight into one sample — the phone is where
// this gets tested, and typing a URL beats hunting through a picker in AR.
const wanted = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('assembly');
const chosen = wanted ? ASSEMBLIES.find((a) => a.id === wanted || a.name.toLowerCase().includes(wanted.toLowerCase())) : undefined;
if (chosen) useStore.getState().loadAssembly(chosen);

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App config={config} /></StrictMode>);

// Expose the store and the live scene for demo/e2e driving (read-only handles).
(window as unknown as { spatialStore?: typeof useStore }).spatialStore = useStore;
(window as unknown as { spatialScene?: typeof getActiveManager }).spatialScene = getActiveManager;

// Register the offline app-shell service worker in production (secure contexts
// only; skipped in dev and where unsupported).
if ('serviceWorker' in navigator && window.isSecureContext && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
