import { useStore } from '../state/store';
import { M_TO_MM } from '../engine/math';
import { partRevision } from '../engine/versioning';

/** Detail card for the selected part: identity, spec, and its live diagnostics. */
export function InspectorPanel(): JSX.Element | null {
  const selectedPartId = useStore((s) => s.selectedPartId);
  const assembly = useStore((s) => s.assembly);
  const placements = useStore((s) => s.placements);
  const diagnostics = useStore((s) => s.diagnostics);
  const removePart = useStore((s) => s.removePart);
  const selectPart = useStore((s) => s.selectPart);

  if (!selectedPartId) return null;
  const part = assembly.parts.find((p) => p.id === selectedPartId);
  if (!part) return null;
  const placement = placements.get(part.id);
  const partDiags = diagnostics.filter((d) => d.partIds.includes(part.id));

  return (
    <div className="inspector">
      <header>
        <h3>{part.name}</h3>
        <button className="close" onClick={() => selectPart(undefined)}>✕</button>
      </header>
      <dl className="spec">
        {part.sku && (<><dt>Part no.</dt><dd>{part.sku}</dd></>)}
        <dt>Revision</dt><dd>Rev {partRevision(part)}{part.supersedes ? ` (was ${part.supersedes})` : ''}</dd>
        <dt>Status</dt><dd className={`status-${placement?.status ?? 'ghost'}`}>{placement?.status ?? 'not placed'}</dd>
        {part.massKg !== undefined && (<><dt>Mass</dt><dd>{(part.massKg * 1000).toFixed(0)} g</dd></>)}
        {part.torqueSpecNm ? (<><dt>Torque</dt><dd>{part.torqueSpecNm} Nm</dd></>) : null}
        {part.mirrorGroup && (<><dt>Handed</dt><dd>yes · group {part.mirrorGroup}</dd></>)}
        <dt>Connectors</dt><dd>{part.connectors.length}</dd>
      </dl>
      {partDiags.length > 0 && (
        <ul className="inspector-diags">
          {partDiags.map((d) => (
            <li key={d.id} className={d.severity}>
              {d.message}
              {d.magnitude !== undefined && d.code.startsWith('FIT') && (
                <span className="mag"> ({d.magnitude.toFixed(2)} {d.code === 'FIT_ORIENTATION' ? '°' : 'mm'})</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {placement && placement.status !== 'ghost' && (
        <button className="secondary" onClick={() => removePart(part.id)}>Remove part</button>
      )}
      <p className="tiny">Target ({(part.targetPose.position[0] * M_TO_MM).toFixed(0)}, {(part.targetPose.position[1] * M_TO_MM).toFixed(0)}, {(part.targetPose.position[2] * M_TO_MM).toFixed(0)}) mm</p>
    </div>
  );
}
