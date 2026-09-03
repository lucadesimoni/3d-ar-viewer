import { useStore } from '../state/store';
import type { Capabilities } from '../engine/tracking/capabilities';

/**
 * iOS AR Quick Look entry.
 *
 * iOS Safari has no WebXR, so for a fully-tracked look at the whole assembly on
 * an iPhone/iPad the app hands a USDZ to the system AR viewer. This renders only
 * when the device advertises Quick Look support *and* the loaded assembly ships
 * a USDZ (`quickLookUrl`) — an `<a rel="ar">` is the platform's launch gesture.
 */
export function QuickLookButton({ capabilities }: { capabilities: Capabilities | undefined }): JSX.Element | null {
  const quickLookUrl = useStore((s) => s.assembly.quickLookUrl);
  if (!capabilities?.quickLook || !quickLookUrl) return null;
  return (
    <a className="quicklook" rel="ar" href={quickLookUrl}>
      <img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=" />
      View in AR (Quick Look)
    </a>
  );
}
