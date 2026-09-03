import { useState } from 'react';
import { useStore } from '../state/store';
import { registerPoints, type Correspondence } from '../engine/alignment';

/**
 * Manual 3-point registration, the reliable floor under every tracking mode.
 *
 * The operator touches three datum features on the real workpiece; each tap
 * records where that datum sits in the world frame. Horn's method then solves
 * the assembly's pose and reports the residual, so the operator knows whether to
 * trust the overlay before they start building against it.
 */
export function RegistrationPanel(): JSX.Element {
  const assembly = useStore((s) => s.assembly);
  const setAnchor = useStore((s) => s.setAnchor);
  const [taps, setTaps] = useState<Correspondence[]>([]);
  const datums = assembly.datums ?? [];

  const recordTap = (datumId: string): void => {
    const datum = datums.find((d) => d.id === datumId);
    if (!datum) return;
    // In a live session the world point comes from a hit-test / reticle; here we
    // seed it from the model with a small jitter so the flow is exercisable.
    const world: [number, number, number] = [
      datum.position[0] + (Math.random() - 0.5) * 0.004,
      datum.position[1] + (Math.random() - 0.5) * 0.004,
      datum.position[2] + (Math.random() - 0.5) * 0.004,
    ];
    setTaps((prev) => [...prev.filter((t) => t.label !== datumId), { model: datum.position, world, label: datumId }]);
  };

  const solve = (): void => {
    const reg = registerPoints(taps);
    if (reg.quality > 0) setAnchor(reg.pose, reg.quality);
  };

  const reg = taps.length >= 3 ? registerPoints(taps) : undefined;

  return (
    <div className="registration">
      <h3>Register to workpiece</h3>
      <p className="hint">Touch each datum on the real part to lock the overlay.</p>
      <ul className="datum-list">
        {datums.map((d) => {
          const done = taps.some((t) => t.label === d.id);
          return (
            <li key={d.id} className={done ? 'done' : ''}>
              <button onClick={() => recordTap(d.id)}>{done ? '✓' : '○'} {d.label}</button>
            </li>
          );
        })}
      </ul>
      {reg && (
        <div className={`reg-result ${reg.rmsMm < 3 ? 'good' : reg.rmsMm < 8 ? 'ok' : 'poor'}`}>
          <span>RMS {reg.rmsMm.toFixed(1)} mm</span>
          <span>max {reg.maxMm.toFixed(1)} mm</span>
          <span>{Math.round(reg.quality * 100)}% confidence</span>
        </div>
      )}
      {reg?.warnings.map((w) => <p key={w} className="reg-warn">⚠ {w}</p>)}
      <div className="reg-actions">
        <button className="primary" disabled={taps.length < 3} onClick={solve}>Lock overlay</button>
        <button className="ghost" onClick={() => { setTaps([]); setAnchor(undefined, 0); }}>Clear</button>
      </div>
    </div>
  );
}
