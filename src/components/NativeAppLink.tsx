import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import type { Capabilities } from '../engine/tracking/capabilities';
import { nativeHostAvailable } from '../native/bridge';

/** The shells' identity: `native/android` and `native/ios`. */
export const ANDROID_PACKAGE = 'com.outthinkx.spatialar';
export const APP_SCHEME = 'spatialar';
/** Where a phone without the app is sent: the releases, where the APK is. */
export const APP_DOWNLOAD = 'https://github.com/lucadesimoni/3d-ar-viewer/releases/latest';

/** `spatialar://open?url=…`: the shells open `url` in their AR view. */
export function nativeAppHref(platform: 'android' | 'ios', target: string): string {
  const query = `url=${encodeURIComponent(target)}`;
  if (platform === 'ios') return `${APP_SCHEME}://open?${query}`;
  // Chrome on Android opens the app when it is installed, and the fallback,
  // the download page, when it is not: no dead link either way.
  return `intent://open?${query}#Intent;scheme=${APP_SCHEME};package=${ANDROID_PACKAGE};`
    + `S.browser_fallback_url=${encodeURIComponent(APP_DOWNLOAD)};end`;
}

type RelatedApp = { platform: string; id?: string };
type WithRelatedApps = Navigator & { getInstalledRelatedApps?: () => Promise<RelatedApp[]> };

/**
 * Whether the Android shell is installed, as Chrome reports it: the web
 * manifest names the app (`related_applications`) and the app names this site
 * (`asset_statements` in its manifest). Undefined where the browser cannot
 * tell, which is every browser but Chrome on Android.
 */
export function useAndroidAppInstalled(): boolean | undefined {
  const [installed, setInstalled] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    const nav = (typeof navigator === 'undefined' ? undefined : navigator) as WithRelatedApps | undefined;
    if (!nav?.getInstalledRelatedApps) return;
    let live = true;
    nav.getInstalledRelatedApps()
      .then((apps) => { if (live) setInstalled(apps.some((a) => a.id === ANDROID_PACKAGE)); })
      .catch(() => { if (live) setInstalled(false); });
    return () => { live = false; };
  }, []);
  return installed;
}

/**
 * "Open in the Spatial AR app": the same job, in the native shell, with the
 * platform's own world tracking.
 *
 * The web app is the product on every phone; the shell is an upgrade for
 * those who have it. So on Android the link appears only when Chrome says the
 * app is installed. iOS cannot tell a page that, so there the link lives only
 * in the AR settings (`compact`), saying the app is needed. Never inside the
 * shell itself; `?nativeapp=off` hides it everywhere.
 */
export function NativeAppLink({ capabilities, compact }: {
  capabilities: Capabilities | undefined;
  compact?: boolean;
}): JSX.Element | null {
  const assembly = useStore((s) => s.assembly);
  const activeStepId = useStore((s) => s.activeStepId);
  const androidInstalled = useAndroidAppInstalled();
  if (typeof window === 'undefined' || nativeHostAvailable()) return null;
  if (new URLSearchParams(window.location.search).get('nativeapp') === 'off') return null;
  const platform = capabilities?.isIOS ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : undefined;
  if (!platform) return null;
  if (platform === 'android' && !androidInstalled) return null;
  if (platform === 'ios' && !compact) return null;

  // The job and the place in it: the shell is a separate app, and only the address crosses.
  const target = new URL(window.location.href);
  target.searchParams.set('assembly', assembly.id);
  if (activeStepId) target.searchParams.set('step', activeStepId);

  return (
    <a className={`appclip native-app ${compact ? 'compact' : ''}`} href={nativeAppHref(platform, target.href)}>
      <span aria-hidden>▣</span>
      <span>
        Open in the Spatial AR app
        {!compact && (
          <em>
            {platform === 'android'
              ? 'ARCore tracking in the app. Opens the download page if it is not installed.'
              : 'ARKit world tracking: the overlay stays where you put it as you walk. Needs the app installed.'}
          </em>
        )}
      </span>
    </a>
  );
}
