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
export function ArSettings({ capabilities, pipeline, onRetryWebXr }: {
  capabilities?: Capabilities;
  pipeline?: PipelineStatus;
  /** Ask for a real AR session from this tap — see `retryWebXr`. */
  onRetryWebXr?: () => Promise<boolean>;
}): JSX.Element {
  const settings = useStore((s) => s.arSettings);
  const setArSettings = useStore((s) => s.setArSettings);
  const snapEnabled = useStore((s) => s.snapEnabled);
  const setSnapEnabled = useStore((s) => s.setSnapEnabled);
  const placement = useStore((s) => s.arPlacement);
  const source = useStore((s) => s.arSource);
  const quality = useStore((s) => s.anchorQuality);
  const gpu = useMemo(() => detectGpu(), []);
  const shapeTarget = useStore((s) => s.assembly.recognition?.label);
  // Sampled while the sheet is open; the sheet is not on screen long enough for
  // a per-frame subscription to be worth it.
  const [view, setView] = useState(() => getActiveManager()?.anchorViewState());
  const [stats, setStats] = useState(() => getActiveManager()?.renderStats());
  const [painted, setPainted] = useState<number | undefined>(() => getActiveManager()?.paintedFraction());
  const [xrWhy, setXrWhy] = useState<string>();
  useEffect(() => {
    void getActiveManager()?.xrFailure().then(setXrWhy);
  }, []);
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
  // What is wrong, if anything — in the order the causes have to be ruled out.
  const fault = (() => {
    if (!stats) return undefined;
    if (stats.contextLost) {
      return { title: 'The graphics context was lost.', detail: 'The browser took the GPU back. Restarting rebuilds it; a page reload always works.' };
    }
    if (stats.renderError) {
      return { title: 'Every frame is failing.', detail: stats.renderError };
    }
    if (stats.frames > 0 && stats.fps < 1) {
      return {
        title: 'The render loop has stopped.',
        detail: stats.clock === 'timer'
          ? `${stats.frames} frames drawn, then nothing — and a plain timer cannot revive it either. This is not a display-timing problem.`
          : `${stats.frames} frames drawn, then nothing. Switching to a timer-driven loop; give it a few seconds.`,
      };
    }
    if (stats.frames === 0) {
      return { title: 'No frame has ever been drawn.', detail: 'The renderer started but produced nothing.' };
    }
    if (painted !== undefined && painted < 0.001 && stats.activeMeshes > 0 && view?.onScreen) {
      return { title: 'Nothing reaches the screen.', detail: `The renderer is running (${Math.round(stats.fps)} fps, ${stats.activeMeshes} meshes, assembly in view) but no pixels are painted — a compositing fault, not a placement one. Moving the assembly will not help.` };
    }
    return undefined;
  })();
  const restart = () => {
    getActiveManager()?.restartRenderLoop();
    setPainted(undefined);
  };

  // Read from the scene, not from a fresh local default: the sheet is unmounted
  // every time it closes, and a switch that forgets what it did reads as a
  // switch that cannot be operated at all.
  const [marker, setMarker] = useState(() => getActiveManager()?.hasTestMarker() ?? false);
  const toggleMarker = (on: boolean) => {
    setMarker(on);
    getActiveManager()?.setTestMarker(on);
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
            A spinning cube pinned 1 m in front of the camera, above this sheet.
            If you cannot see it, nothing is being drawn over the camera at all —
            and moving the assembly will not help.
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
                : `${Math.round(stats.fps)} fps · ${stats.frames}${stats.clock === 'timer' ? ' · timer' : ''}${stats.stalls ? ` · ${stats.stalls} restarts` : ''}`}
          </dd>
        </div>
        <div><dt>Camera</dt><dd>{stats?.camera ?? '—'}</dd></div>
        {/* Whether real AR was even possible, and if not, why. This is the
            difference between an overlay that stays on the bench and one that
            walks with you, so it does not belong in a console. */}
        <div>
          <dt>WebXR</dt>
          <dd>
            {source === 'webxr' ? 'in session'
              : !capabilities?.webxrSupported ? 'not in this browser'
                : capabilities.immersiveAr ? 'supported, not running'
                  : 'no immersive-ar'}
          </dd>
        </div>
        {/* The only number here that proves a pixel reached the screen. */}
        <div>
          <dt>Overlay painted</dt>
          <dd>{painted === undefined ? '—' : `${(painted * 100).toFixed(1)}% of the view`}</dd>
        </div>
      </dl>

      {/* An empty overlay has causes that need different fixes, and they look
          identical from outside. Name whichever one it is.
          The condition deliberately does not require a pixel measurement: the
          readback can legitimately be unavailable, and gating the whole report
          on it is how a stalled render loop stayed unreported. */}
      {/* Informational, not a fault: the camera path works, it simply cannot
          track walking. Kept distinct from the renderer diagnosis so that each
          says one thing. */}
      {source !== 'webxr' && capabilities?.webxrSupported && (
        <p className="ar-set-help ar-xr-note" role="status">
          <strong>Running without real AR tracking.</strong>{' '}
          {xrWhy ?? 'The session was not entered.'}{' '}
          Without it the overlay turns with you but does not stay put when you walk.
          {onRetryWebXr && (
            <button
              className="secondary ar-restart"
              onClick={() => { void onRetryWebXr().then((ok) => { if (!ok) void getActiveManager()?.xrFailure().then(setXrWhy); }); }}
            >
              Try real AR tracking
            </button>
          )}
        </p>
      )}

      {fault && (
        <p className="ar-set-help ar-diagnosis" role="status">
          <strong>{fault.title}</strong> {fault.detail}
          <button className="secondary ar-restart" onClick={restart}>Restart the renderer</button>
        </p>
      )}
    </div>
  );
}
