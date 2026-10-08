import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logEvent } from '../diagnostics/log';

/**
 * The last line: a render that throws must not leave a blank screen.
 *
 * Without this, any exception in any component unmounts the whole tree — on a
 * phone in someone's hand that is a white page with no way back but knowing to
 * reload. Say what happened, offer the reload, and put the error in the
 * diagnostics log, which is the only place it can be read from later.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logEvent('error', `render failed: ${error.name}: ${error.message}`, {
      stack: error.stack?.slice(0, 800),
      component: info.componentStack?.slice(0, 400),
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="app-failed" role="alert">
        <h2>Something went wrong</h2>
        <p>The app hit an error it could not recover from. Your notes are saved on this device.</p>
        <button className="primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
