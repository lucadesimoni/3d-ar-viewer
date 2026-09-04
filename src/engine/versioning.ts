import type { AssemblyDef, PartDef } from './types';

/**
 * Clean, first-class part versioning.
 *
 * Every part carries a revision, and a part is only fully identified by its
 * number *and* revision — "GBX-200 Rev C" is a different thing from "Rev B",
 * often with different mating geometry. This module gives the app one correct
 * way to order revisions, render a versioned label, roll a Bill of Materials,
 * detect a wrong-revision part, and stamp the whole assembly with a stable
 * fingerprint so a build can be traced to exactly the parts that went into it.
 *
 * Two revision styles are supported and auto-detected:
 *  - aerospace letter revisions: A < B < … < Z < AA < AB … (bijective base-26),
 *  - dotted numeric / semver-ish: 1 < 1.2 < 1.2.3 < 2.
 */

export const DEFAULT_REVISION = '—';

export const partRevision = (part: PartDef): string => part.revision ?? DEFAULT_REVISION;

/** `GBX-200 Rev C` (or the part name when it has no SKU). */
export function partVersionLabel(part: PartDef): string {
  const id = part.sku ?? part.name;
  const rev = part.revision;
  return rev ? `${id} Rev ${rev}` : id;
}

type RevKind = 'letter' | 'numeric' | 'other';

function revKind(rev: string): RevKind {
  if (/^[A-Za-z]+$/.test(rev)) return 'letter';
  if (/^\d+(\.\d+)*$/.test(rev)) return 'numeric';
  return 'other';
}

/** Bijective base-26 value of a letter revision: A=1, Z=26, AA=27, AB=28… */
function letterValue(rev: string): number {
  let v = 0;
  for (const ch of rev.toUpperCase()) v = v * 26 + (ch.charCodeAt(0) - 64);
  return v;
}

/**
 * Order two revisions: -1 if `a` is older, 1 if newer, 0 if equal.
 *
 * Same-style revisions compare by their natural order; mixed or unparseable
 * styles fall back to a stable lexicographic compare so the result is always
 * total and deterministic.
 */
export function compareRevisions(a: string, b: string): number {
  if (a === b) return 0;
  const ka = revKind(a);
  const kb = revKind(b);
  if (ka === 'letter' && kb === 'letter') {
    return Math.sign(letterValue(a) - letterValue(b));
  }
  if (ka === 'numeric' && kb === 'numeric') {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return Math.sign(d);
    }
    return 0;
  }
  return a < b ? -1 : 1;
}

export const isRevisionNewer = (a: string, b: string): boolean => compareRevisions(a, b) > 0;

export type RevisionRelation = 'match' | 'older' | 'newer' | 'incomparable';

/**
 * Relate an installed/recognised revision to the one the design expects.
 *
 * `older` is the dangerous case on a shop floor — a superseded part fitted after
 * an engineering change — so it is called out distinctly from `newer`.
 */
export function revisionRelation(expected: string, actual: string): RevisionRelation {
  if (expected === actual) return 'match';
  if (revKind(expected) !== revKind(actual) || revKind(expected) === 'other') return 'incomparable';
  const c = compareRevisions(actual, expected);
  return c === 0 ? 'match' : c < 0 ? 'older' : 'newer';
}

export interface BomLine {
  sku: string;
  name: string;
  revision: string;
  qty: number;
  /** Total mass of this line (unit mass × qty), kg, when known. */
  massKg?: number;
}

/**
 * Roll a Bill of Materials: one line per distinct part number *and* revision,
 * with quantities aggregated. Splitting on revision is deliberate — two
 * revisions of the same SKU are different line items on a real BOM.
 */
export function buildBom(assembly: AssemblyDef): BomLine[] {
  const lines = new Map<string, BomLine>();
  for (const part of assembly.parts) {
    const sku = part.sku ?? part.id;
    const revision = partRevision(part);
    const key = `${sku}@@${revision}`;
    const existing = lines.get(key);
    if (existing) {
      existing.qty += 1;
      if (part.massKg !== undefined) existing.massKg = (existing.massKg ?? 0) + part.massKg;
    } else {
      lines.set(key, { sku, name: part.name, revision, qty: 1, massKg: part.massKg });
    }
  }
  return [...lines.values()].sort((a, b) => a.sku.localeCompare(b.sku) || compareRevisions(a.revision, b.revision));
}

export const bomTotalMass = (bom: BomLine[]): number =>
  bom.reduce((sum, l) => sum + (l.massKg ?? 0), 0);

/**
 * Stable content fingerprint of an assembly's versioned parts.
 *
 * Hashes each part's id + SKU + revision (order-independent) with FNV-1a, so the
 * same set of versioned parts always yields the same short hex stamp and any
 * revision bump changes it. Useful as an as-built build id on a traveller.
 */
export function assemblyFingerprint(assembly: AssemblyDef): string {
  const parts = assembly.parts
    .map((p) => `${p.id}:${p.sku ?? ''}:${partRevision(p)}`)
    .sort();
  let h = 0x811c9dc5;
  const str = `${assembly.id}:${assembly.revision}|${parts.join('|')}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** One-line human version stamp for the whole assembly. */
export function assemblyVersionStamp(assembly: AssemblyDef): string {
  return `${assembly.name} Rev ${assembly.revision} · build ${assemblyFingerprint(assembly)}`;
}
