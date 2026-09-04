import { useStore } from '../state/store';
import { buildBom, bomTotalMass, assemblyFingerprint } from '../engine/versioning';

/**
 * Versioned Bill of Materials.
 *
 * One line per part number *and* revision (two revisions of a SKU are distinct
 * line items, as on a real BOM), with quantities and mass rolled up, plus the
 * assembly's content fingerprint — a stable build id derived from every part's
 * revision, so an as-built record traces to exactly the versions that went in.
 */
export function BomPanel(): JSX.Element {
  const assembly = useStore((s) => s.assembly);
  const bom = buildBom(assembly);
  const totalMass = bomTotalMass(bom);
  const fingerprint = assemblyFingerprint(assembly);

  return (
    <div className="bom">
      <h3>Bill of materials</h3>
      <p className="hint">
        {assembly.name} · Rev {assembly.revision} · build <code>{fingerprint}</code>
      </p>
      <div className="bom-scroll">
        <table className="bom-table">
          <thead>
            <tr><th>Part no.</th><th>Description</th><th>Rev</th><th className="num">Qty</th></tr>
          </thead>
          <tbody>
            {bom.map((l) => (
              <tr key={`${l.sku}-${l.revision}`}>
                <td className="mono">{l.sku}</td>
                <td>{l.name}</td>
                <td className="rev">{l.revision}</td>
                <td className="num">{l.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="bom-total">
        {bom.reduce((n, l) => n + l.qty, 0)} parts · {bom.length} line items
        {totalMass > 0 ? ` · ${totalMass.toFixed(2)} kg` : ''}
      </p>
    </div>
  );
}
