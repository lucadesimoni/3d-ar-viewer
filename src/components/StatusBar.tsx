import { MODE_LABELS, type Capabilities } from '../engine/tracking/capabilities';
import type { PipelineStatus } from '../vision/pipeline';
import { useStore } from '../state/store';
import { detectGpu, gpuLabel } from '../render/perf';
import { getActiveRenderBackend } from '../render/babylon/managerRegistry';
import { useEffect, useMemo, useState } from 'react';

interface Props {
  capabilities: Capabilities | undefined;
  pipeline: PipelineStatus | undefined;
  onEnterAr: () => void;
  arActive: boolean;
}

/** Top bar: identity, the AR-entry button, and honest capability badges. */
export function StatusBar({ capabilities, pipeline, onEnterAr, arActive }: Props): JSX.Element {
  const anchorQuality = useStore((s) => s.anchorQuality);
  const gpu = useMemo(() => detectGpu(), []);
  // The active engine is created asynchronously; reflect WebGPU once it is live.
  const [backend, setBackend] = useState<'webgpu' | 'webgl' | undefined>(undefined);
  useEffect(() => {
    const id = setInterval(() => setBackend(getActiveRenderBackend()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="status-bar">
      <div className="brand">
        <span className="logo">◈</span>
        <div>
          <strong>Spatial Assembly AR</strong>
          <span className="tagline">Guided assembly · fit &amp; snap verification · spatial co-presence</span>
        </div>
      </div>

      <div className="badges">
        <Badge on={capabilities?.secureContext} label="HTTPS" />
        <Badge on={capabilities?.webgl2} label="WebGL2" />
        <span className={`badge ${gpu.accelerated ? 'on' : 'off'}`} title={`Renderer: ${gpu.renderer || 'unknown'} · ML: ${gpu.mlProvider}`}>GPU · {backend === 'webgpu' ? 'WebGPU' : gpuLabel(gpu)}</span>
        <Badge on={capabilities?.immersiveAr} label="WebXR" />
        <Badge on={capabilities?.camera} label="Camera" />
        <Badge on={pipeline?.openCv} label="OpenCV" />
        <Badge on={pipeline?.detector || pipeline?.classifier} label={`ONNX${pipeline?.provider ? ` · ${pipeline.provider}` : ''}`} />
        {anchorQuality > 0 && (
          <span className="badge on">Anchor {Math.round(anchorQuality * 100)}%</span>
        )}
      </div>

      <button className={`ar-enter ${arActive ? 'active' : ''}`} onClick={onEnterAr}>
        {arActive ? 'Exit AR' : `Enter AR · ${capabilities ? MODE_LABELS[capabilities.recommended] : '…'}`}
      </button>
    </header>
  );
}

function Badge({ on, label }: { on: boolean | undefined; label: string }): JSX.Element {
  return <span className={`badge ${on ? 'on' : 'off'}`} title={on ? 'available' : 'unavailable'}>{label}</span>;
}
