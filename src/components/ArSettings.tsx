import { useStore } from '../state/store';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { MODE_LABELS, type Capabilities } from '../engine/tracking/capabilities';
import type { PipelineStatus } from '../vision/pipeline';
import { detectGpu, gpuLabel } from '../render/perf';
import { useEffect, useMemo, useState } from 'react';

/** Common working surfaces, so the height is one tap rather than a slider hunt. */
const SURFACES: { label: string; height: number }[] = [
  { label: 'Floor', height: 0 },
  { label: 'Table', height: 0.75 },
  { label: 'Bench', height: 0.9 },
];

/**
 * AR settings, reachable from the passthrough view.
 *
 * These are mostly not preferences — they are the measurements the browser
 * refuses to give us. There is no camera-calibration API, no way to know how
 * high the device is being held, and no depth sensor to tell a table from the
 * floor, so the overlay's scale and the placement plane both rest on
 * assumptions. When they are wrong the operator can see it (the virtual
 * shelf is visibly bigger than the real one) and this is where they correct it,
 * live, with the camera running.
 */
export function ArSettings({ capabilities, pipeline, onDismiss }: {
  capabilities?: Capabilities;
  pipeline?: PipelineStatus;
  /** Close the sheet — the marker is behind it otherwise. */
  onDismiss?: () => void;
}): JSX.Element {
  const settings = useStore((s) => s.arSettings);
  const setArSettings = useStore((s) => s.setArSettings);
  const snapEnabled = useStore((s) => s.snapEnabled);
  const setSnapEnabled = useStore((s) => s.setSnapEnabled);
  const placement = useStore((s) => s.arPlacement);
  const quality = useStore((s) => s.anchorQuality);
  const gpu = useMemo(() => detectGpu(), []);
  const shapeTarget = useStore((s) => s.assembly.recognition?.label);
  // Sampled while the sheet is open; the sheet is not on screen long enough for
  // a per-frame subscription to be worth it.
  const [view, setView] = useState(() => getActiveManager()?.anchorViewState());
  const [stats, setStats] = useState(() => getActiveManager()?.renderStats());
  const [painted, setPainted] = useState<number | undefined>(() => getActiveManager()?.paintedFraction());
  useEffect(() => {
    const id = window.setInterval(() => {
      const m = getActiveManager();
      setView(m?.anchorViewState());
      setStats(m?.renderStats());
    }, 250);
    // The pixel readback is expensive, so it runs on its own slower beat.
    const paint = window.setInterval(() => setPainted(getActiveManager()?.paintedFraction()), 1000);
    return () => { window.clearInterval(id); window.clearInterval(paint); };
  }, []);
  const [marker, setMarker] = useState(false);
  const toggleMarker = (on: boolean) => {
    setMarker(on);
    getActiveManager()?.setTestMarker(on);
    // The marker sits in the middle of the view, which is behind this sheet.
    // Switching it on and staying here shows you a covered marker and no
    // answer — the exact false negative it exists to rule out.
    if (on) onDismiss?.();
  };

  const setFov = (v: number) => {
    setArSettings({ cameraFovDeg: v });
    getActiveManager()?.setCameraFov(v);
  };
  // The placement plane is the drop from the device down to the surface: how
  // high the phone is held, less how high the surface stands off the floor.
  const applyDrop = (eye: number, surface: number) =>
    getActiveManager()?.setSurfaceDrop(eye - surface);
  const setEye = (v: number) => {
    setArSettings({ eyeHeightM: v });
    applyDrop(v, settings.surfaceHeightM);
  };
  const setSurface = (v: number) => {
    const clamped = Math.max(0, Math.min(settings.eyeHeightM - 0.2, v));
    setArSettings({ surfaceHeightM: clamped });
    applyDrop(settings.eyeHeightM, clamped);
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

      {/* Not everything is built on the floor. The tap decides *where* on the
          surface; this decides which surface — otherwise a bench assembly sinks
          through the bench onto the floor behind it. */}
      <div className="ar-set">
        <span className="ar-set-label">
          Place on
          <em>{settings.surfaceHeightM < 0.02 ? 'the floor' : `${settings.surfaceHeightM.toFixed(2)} m up`}</em>
        </span>
        <div className="ar-chips" role="group" aria-label="Surface to place on">
          {SURFACES.map((s) => (
            <button
              key={s.label}
              type="button"
              className={`ar-chip ${Math.abs(settings.surfaceHeightM - s.height) < 0.03 ? 'active' : ''}`}
              onClick={() => setSurface(s.height)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          type="range" min={0} max={1.2} step={0.05}
          value={settings.surfaceHeightM}
          aria-label="Surface height above the floor"
          onChange={(e) => setSurface(Number(e.target.value))}
        />
        <span className="ar-set-help">Height of the surface you are aiming at, above the floor.</span>
      </div>

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
        <span>
          Re-anchor automatically when the object is recognised
          <em className="ar-set-help">
            {shapeTarget
              ? `Matches the ${shapeTarget} by shape — no model needed.`
              : 'This assembly has no shape target, so only your placement anchors it.'}
          </em>
        </span>
      </label>

      <label className="ar-toggle">
        <input type="checkbox" checked={snapEnabled} onChange={(e) => setSnapEnabled(e.target.checked)} />
        <span>Snap parts to their mates when placed</span>
      </label>

      {/* The one control that separates "the overlay is somewhere else" from
          "the overlay is never drawn". Everything else here assumes rendering
          works; this checks that assumption directly. */}
      <label className="ar-toggle">
        <input type="checkbox" checked={marker} onChange={(e) => toggleMarker(e.target.checked)} />
        <span>
          Show a test marker
          <em className="ar-set-help">
            A spinning cube pinned 1 m in front of the camera. If you cannot see
            this, nothing is being drawn over the camera at all — and moving the
            assembly will not help.
          </em>
        </span>
      </label>

      <dl className="ar-facts">
        <div><dt>Anchor</dt><dd>{placement === 'idle' ? 'none' : `${placement} · ${Math.round(quality * 100)}%`}</dd></div>
        {/* Answers "camera works, but I see nothing" without a debugger: either
            the assembly is in view and the problem is rendering, or it is not
            and the problem is where you are looking. */}
        <div>
          <dt>In view</dt>
          <dd>
            {!view ? '—'
              : view.onScreen ? `yes · ${view.distanceM.toFixed(1)} m`
                : `no · ${view.distanceM.toFixed(1)} m, ${view.direction}`}
          </dd>
        </div>
        <div><dt>Mode</dt><dd>{capabilities ? MODE_LABELS[capabilities.recommended] : '—'}</dd></div>
        <div>
          <dt>Renderer</dt>
          <dd>{stats?.backend === 'webgpu' ? 'WebGPU' : `WebGL · ${gpuLabel(gpu)}`}</dd>
        </div>
        {/* Say plainly whether part recognition can run at all. Silence here is
            what made "Looking for Base plate…" look like a live search. */}
        <div>
          <dt>Part recognition</dt>
          <dd>{pipeline?.detector ? 'model loaded' : 'no model — off'}</dd>
        </div>
        <div><dt>Drawn</dt><dd>{stats ? `${stats.activeMeshes} of ${stats.meshes} · ${stats.partMeshes} parts` : '—'}</dd></div>
        <div><dt>Canvas</dt><dd>{stats ? `${stats.cssSize.join('×')} → ${stats.bufferSize.join('×')}` : '—'}</dd></div>
        <div><dt>Effective FOV</dt><dd>{stats ? `${stats.fovDeg.toFixed(1)}°` : '—'}</dd></div>
        {/* Is the renderer alive at all? A stopped loop, a lost context and a
            failing frame all look identical from the outside: a blank canvas. */}
        <div>
          <dt>Frames</dt>
          <dd>
            {!stats ? '—'
              : stats.contextLost ? 'context lost'
                : `${Math.round(stats.fps)} fps · ${stats.frames}`}
          </dd>
        </div>
        <div><dt>Camera</dt><dd>{stats?.camera ?? '—'}</dd></div>
        {/* The only number here that proves a pixel reached the screen. */}
        <div>
          <dt>Overlay painted</dt>
          <dd>{painted === undefined ? '—' : `${(painted * 100).toFixed(1)}% of the view`}</dd>
        </div>
      </dl>

      {/* An empty overlay has exactly three causes, and they need different
          fixes. Say which one it is rather than leaving it to be inferred. */}
      {painted !== undefined && painted < 0.001 && (stats?.activeMeshes ?? 0) > 0 && (
        <p className="ar-set-help ar-diagnosis" role="status">
          <strong>Nothing is being drawn.</strong>{' '}
          {stats?.contextLost
            ? 'The graphics context was lost — the browser took the GPU back. Reload the page.'
            : stats?.renderError
              ? `Every frame is failing: ${stats.renderError}`
              : (stats?.fps ?? 0) < 1
                ? `The render loop has stopped after ${stats?.frames ?? 0} frames. Reload the page.`
                : `The renderer is running (${Math.round(stats?.fps ?? 0)} fps, ${stats?.activeMeshes} meshes) but no pixels reach the screen — a compositing fault, not a placement one. Moving the assembly will not help.`}
        </p>
      )}
    </div>
  );
}
