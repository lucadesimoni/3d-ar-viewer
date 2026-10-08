import { useEffect, useRef, useState } from 'react';
import type { Capabilities } from '../engine/tracking/capabilities';
import { buildReport } from '../diagnostics/report';
import { copyReport, exportReport } from '../diagnostics/export';
import { logEvent } from '../diagnostics/log';
import { loadLastSession, clearLastSession, saveLastSession, type SavedReport } from '../diagnostics/lastSession';
import { controlsOnScreen, visibleArea } from '../ui/controlsOnScreen';
import { DiagnosticsExport } from './DiagnosticsExport';

/** How often the running AR session's report is kept on the device. */
export const KEEP_EVERY_MS = 10_000;
/** How long the AR bar gets to appear before its absence counts. */
export const CONTROLS_GRACE_MS = 2500;

/** The page inside an iOS web view — what the Needle App Clip hosts it in. */
export function inIosWebView(caps: Pick<Capabilities, 'isIOS' | 'isIPad'> | undefined, ua = navigator.userAgent): boolean {
  const ios = Boolean(caps?.isIOS || caps?.isIPad) || /iPhone|iPad|iPod/.test(ua);
  return ios && !/Safari\//.test(ua);
}

/** Whether a kept report is worth offering unasked: it came from where the controls go missing. */
export function worthOffering(saved: SavedReport | undefined): boolean {
  if (!saved) return false;
  const r = saved.report;
  const missing = r.log?.some((e) => e.message === 'AR controls not on screen');
  const ua = r.device?.userAgent ?? '';
  const webView = Boolean(r.capabilities?.isIOS || r.capabilities?.isIPad || /iPhone|iPad/.test(ua)) && !/Safari\//.test(ua);
  return Boolean(missing || webView);
}

/**
 * Every way to get the log out when the ordinary buttons cannot be reached.
 *
 * The AR controls have been seen not to appear at all inside the Needle App
 * Clip — and the log export is behind them. Three routes, none depending on
 * the bottom bar:
 *  - when the bar is measured off screen, a small button at the top of the
 *    view, which opens this panel (and the measurement goes in the log);
 *  - a three-finger tap anywhere opens it too, whatever the layout did;
 *  - the running session's report is kept on the device, and the next start
 *    offers it from the ordinary page.
 */
export function LogRescue({ arActive, onExitAr, capabilities }: {
  arActive: boolean;
  onExitAr: () => void;
  capabilities: Capabilities | undefined;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [controlsMissing, setControlsMissing] = useState(false);
  // Read once, before this page's own AR can overwrite it.
  const [offer, setOffer] = useState<SavedReport | undefined>(() => {
    const saved = loadLastSession();
    return worthOffering(saved) ? saved : undefined;
  });
  const [offerText, setOfferText] = useState<string>();
  const [offerMessage, setOfferMessage] = useState<string>();
  const caps = useRef(capabilities);
  caps.current = capabilities;

  // Three fingers, anywhere: the route that needs no button at all.
  useEffect(() => {
    const onTouch = (e: TouchEvent): void => {
      if (e.touches.length < 3) return;
      logEvent('ui', 'log opened with a three-finger tap', { inAr: arActive });
      setOpen(true);
    };
    document.addEventListener('touchstart', onTouch, { passive: true });
    return () => document.removeEventListener('touchstart', onTouch);
  }, [arActive]);

  // Keep the running session's report, and once more as it ends.
  useEffect(() => {
    if (!arActive) return;
    const keep = (): void => {
      void buildReport(caps.current).then((r) => saveLastSession(r)).catch(() => undefined);
    };
    const timer = window.setInterval(keep, KEEP_EVERY_MS);
    const onHide = (): void => { if (document.visibilityState === 'hidden') keep(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', keep);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', keep);
      keep();
    };
  }, [arActive]);

  // Are the controls on screen? Measured, and the measurement logged once.
  useEffect(() => {
    if (!arActive) { setControlsMissing(false); return; }
    let logged = false;
    const measure = (): void => {
      const el = document.querySelector('.ar-bar');
      const r = el?.getBoundingClientRect();
      const view = visibleArea();
      const ok = controlsOnScreen(r, view);
      setControlsMissing(!ok);
      if (!ok && !logged) {
        logged = true;
        const app = document.querySelector('.app')?.getBoundingClientRect();
        const vv = window.visualViewport;
        logEvent('ui', 'AR controls not on screen', {
          bar: r ? [r.left, r.top, r.width, r.height].map(Math.round) : null,
          app: app ? [app.width, app.height].map(Math.round) : null,
          window: [window.innerWidth, window.innerHeight],
          visual: vv ? [Math.round(vv.width), Math.round(vv.height), Number(vv.scale.toFixed(2))] : null,
          appHeightVar: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
          iosWebView: inIosWebView(caps.current),
        });
      }
    };
    const first = window.setTimeout(measure, CONTROLS_GRACE_MS);
    const again = window.setInterval(measure, 2000);
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(again);
      window.removeEventListener('resize', measure);
    };
  }, [arActive]);

  return (
    <>
      {arActive && controlsMissing && !open && (
        <button className="log-rescue-trigger" onClick={() => setOpen(true)}>
          Controls missing — log · exit
        </button>
      )}
      {open && (
        <div className="log-rescue" role="dialog" aria-label="Diagnostics log">
          <strong>Diagnostics log</strong>
          <DiagnosticsExport capabilities={capabilities} inAr={arActive} />
          <div className="log-rescue-actions">
            {arActive && <button className="danger" onClick={() => { setOpen(false); onExitAr(); }}>Exit AR</button>}
            <button onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
      {!arActive && offer && (
        <div className="log-rescue-offer" role="status">
          <p>
            The log of the AR session at {new Date(offer.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} is
            saved on this device{offerMessage ? ` — ${offerMessage}` : '.'}
          </p>
          <div className="log-rescue-actions">
            <button className="primary" onClick={() => {
              void exportReport(offer.report).then((r) => setOfferMessage(r.message)).catch(() => undefined);
            }}>Save it</button>
            <button onClick={() => {
              void copyReport(offer.report).then((r) => { setOfferText(r.text); setOfferMessage(r.message); });
            }}>Show as text</button>
            <button onClick={() => { clearLastSession(); setOffer(undefined); }}>Dismiss</button>
          </div>
          {offerText && <textarea readOnly value={offerText} aria-label="Saved log, to select and copy" rows={6} />}
        </div>
      )}
    </>
  );
}
