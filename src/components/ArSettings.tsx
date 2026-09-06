import { useStore } from '../state/store';
import { getActiveManager, getActiveRenderBackend } from '../render/babylon/managerRegistry';
import { MODE_LABELS, type Capabilities } from '../engine/tracking/capabilities';
import { detectGpu, gpuLabel } from '../render/perf';
import { useMemo } from 'react';

/**
 * AR settings, reachable from the passthrough view.
 *
 * These are not preferences — they are the two measurements the browser refuses
 * to give us. There is no camera-calibration API and no way to know how high the
 * device is being held, so the overlay's scale and the floor's distance both
 * rest on assumptions. When they are wrong the operator can see it (the virtual
 * shelf is visibly bigger than the real one) and this is where they correct it,
 * live, with the camera running.
 */
export function ArSettings({ capabilities }: { capabilities?: Capabilities }): JSX.Element {
  const settings = useStore((s) => s.arSettings);
  const setArSettings = useStore((s) => s.setArSettings);
  const snapEnabled = useStore((s) => s.snapEnabled);
  const setSnapEnabled = useStore((s) => s.setSnapEnabled);
  const placement = useStore((s) => s.arPlacement);
  const quality = useStore((s) => s.anchorQuality);
  const gpu = useMemo(() => detectGpu(), []);

  const setFov = (v: number) => {
    setArSettings({ cameraFovDeg: v });
    getActiveManager()?.setCameraFov(v);
  };
  const setEye = (v: number) => {
    setArSettings({ eyeHeightM: v });
    getActiveManager()?.setEyeHeight(v);
  };

  return (
    <div className="panel ar-settings">
      <h3>AR settings</h3>

      <label className="ar-set">
        <span className="ar-set-label">
          Camera field of view
          <em>{settings.cameraFovDeg.toFixed(0)}°</em>
        </span>
        <input
          type="range" min={35} max={110} step={1}
          value={settings.cameraFovDeg}
          onChange={(e) => setFov(Number(e.target.value))}
        />
        <span className="ar-set-help">Overlay too big? Increase. Too small? Decrease.</span>
      </label>

      <label className="ar-set">
        <span className="ar-set-label">
          Device held at
          <em>{settings.eyeHeightM.toFixed(2)} m</em>
        </span>
        <input
          type="range" min={0.6} max={2} step={0.05}
          value={settings.eyeHeightM}
          onChange={(e) => setEye(Number(e.target.value))}
        />
        <span className="ar-set-help">Sets the floor plane while you aim. Watch the ring settle.</span>
      </label>

      <label className="ar-toggle">
        <input
          type="checkbox" checked={settings.placeOnEntry}
          onChange={(e) => setArSettings({ placeOnEntry: e.target.checked })}
        />
        <span>
          Ask where to put it when AR starts
          <em className="ar-set-help">Off: opens where you left it. "Move" repositions on demand.</em>
        </span>
      </label>

      <label className="ar-toggle">
        <input
          type="checkbox" checked={settings.autoRecognize}
          onChange={(e) => setArSettings({ autoRecognize: e.target.checked })}
        />
        <span>Re-anchor automatically when the object is recognised</span>
      </label>

      <label className="ar-toggle">
        <input type="checkbox" checked={snapEnabled} onChange={(e) => setSnapEnabled(e.target.checked)} />
        <span>Snap parts to their mates when placed</span>
      </label>

      <dl className="ar-facts">
        <div><dt>Anchor</dt><dd>{placement === 'idle' ? 'none' : `${placement} · ${Math.round(quality * 100)}%`}</dd></div>
        <div><dt>Mode</dt><dd>{capabilities ? MODE_LABELS[capabilities.recommended] : '—'}</dd></div>
        <div><dt>Renderer</dt><dd>{getActiveRenderBackend() === 'webgpu' ? 'WebGPU' : gpuLabel(gpu)}</dd></div>
      </dl>
    </div>
  );
}
