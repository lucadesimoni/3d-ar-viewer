import { useStore } from '../state/store';
import type { Capabilities } from '../engine/tracking/capabilities';

/**
 * Where the App Clip that provides WebXR on iOS is hosted.
 *
 * Overridable with `?appclip=<base>` so a deployment can point at its own clip
 * — or at nothing, if sending operators to a third party is not acceptable.
 */
const DEFAULT_APP_CLIP = 'https://appclip.needle.tools/ar';

export function appClipHref(base: string, target: string): string {
  return `${base}?url=${encodeURIComponent(target)}`;
}

/** `?appclip=` overrides the host; `?appclip=off` disables the offer entirely. */
export function appClipBase(search: string): string | undefined {
  const override = new URLSearchParams(search).get('appclip');
  if (override === 'off') return undefined;
  return override || DEFAULT_APP_CLIP;
}

/**
 * The iOS route to real AR tracking.
 *
 * iOS Safari has no WebXR and will not have it, so on an iPhone or iPad this
 * app runs its camera-passthrough path: orientation only, and the overlay
 * travels with the operator when they walk. An App Clip is the way out — a
 * native ARKit host that provides the WebXR API to an ordinary web page and
 * launches from a link without an App Store install. The same WebXR code that
 * runs in Chrome on Android then runs on iOS.
 *
 * This is an outward link to a third-party service, and it carries this app's
 * URL as a parameter, so it says where it goes and can be turned off with
 * `?appclip=off`. Nothing but the public page address is handed over.
 */
export function AppClipLink({ capabilities, compact }: {
  capabilities: Capabilities | undefined;
  compact?: boolean;
}): JSX.Element | null {
  const assembly = useStore((s) => s.assembly);
  const activeStepId = useStore((s) => s.activeStepId);
  if (!capabilities?.isIOS || capabilities.immersiveAr) return null;
  const base = appClipBase(typeof window === 'undefined' ? '' : window.location.search);
  if (!base || typeof window === 'undefined') return null;

  // Carry the job *and the place in it*. A clip is a separate browsing context:
  // the address is the only thing that crosses, so anything not in it is lost.
  const target = new URL(window.location.href);
  target.searchParams.set('assembly', assembly.id);
  if (activeStepId) target.searchParams.set('step', activeStepId);

  return (
    <a className={`appclip ${compact ? 'compact' : ''}`} href={appClipHref(base, target.href)}>
      <span aria-hidden>◎</span>
      <span>
        Open with real AR tracking
        {!compact && (
          <em>
            iOS has no WebXR in the browser. This opens the same page in an App Clip
            that provides ARKit tracking — no install, and the overlay stays where you
            put it when you walk around.
          </em>
        )}
      </span>
    </a>
  );
}
