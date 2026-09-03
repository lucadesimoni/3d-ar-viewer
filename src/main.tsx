import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import { useStore } from './state/store';

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);

// Expose the store for demo/e2e driving (harmless; read-only handle).
(window as unknown as { spatialStore?: typeof useStore }).spatialStore = useStore;
