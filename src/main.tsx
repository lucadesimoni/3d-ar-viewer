import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import { useStore } from './state/store';
import { parseUiConfigFromParams } from './ui/config';

// Config for the standalone/iframe build comes from URL params, e.g.
//   /?ui=minimal&embedded=1&accent=%23ff7a00
const config = parseUiConfigFromParams(typeof window !== 'undefined' ? window.location.search : '');

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App config={config} /></StrictMode>);

// Expose the store for demo/e2e driving (harmless; read-only handle).
(window as unknown as { spatialStore?: typeof useStore }).spatialStore = useStore;

// Register the offline app-shell service worker in production (secure contexts
// only; skipped in dev and where unsupported).
if ('serviceWorker' in navigator && window.isSecureContext && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
