/**
 * Operator notes, pinned to the parts they are about.
 *
 * A note on a shop floor is about a component — "this bolt was replaced", "burr
 * on the mating face, filed" — so it is attached to a part rather than to a
 * point in the room. That matters the moment anything moves: the assembly is
 * re-placed, the view is exploded, the build animation plays. A world-space pin
 * would be left standing where the part used to be, pointing at nothing.
 *
 * The position is kept in the part's own frame, so the pin sits exactly where
 * the operator touched and travels with the part wherever it goes.
 */
export interface Annotation {
  id: string;
  partId: string;
  /** Where on the part, in the part's local frame, in metres. */
  local: [number, number, number];
  text: string;
  /** Unix ms, so a reader can tell a note from this shift from one from May. */
  at: number;
}

const KEY = 'spatial-ar.annotations.v1';
/** Enough for a working session's worth of notes; a guard, not a design limit. */
const MAX_PER_ASSEMBLY = 200;
const MAX_TEXT = 280;

export type AnnotationsByAssembly = Record<string, Annotation[]>;

/**
 * Read the stored notes.
 *
 * Storage can be absent, full, or refused outright — a private window, a
 * browser set to block site data, a tablet whose storage was cleared between
 * shifts. None of that is a reason to fail to start, so anything unreadable is
 * treated as "no notes yet".
 */
export function loadAnnotations(): AnnotationsByAssembly {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: AnnotationsByAssembly = {};
    for (const [assemblyId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      out[assemblyId] = list.filter(isAnnotation).slice(0, MAX_PER_ASSEMBLY);
    }
    return out;
  } catch {
    return {};
  }
}

/** Write them back. A refusal here loses a note, not the session. */
export function saveAnnotations(all: AnnotationsByAssembly): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Quota, a private window, storage disabled: the note stays in memory for
    // this session and is gone on reload. Better than an unusable app.
  }
}

export function makeAnnotation(
  partId: string, local: [number, number, number], text: string,
): Annotation {
  return {
    id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    partId,
    local,
    text: text.trim().slice(0, MAX_TEXT),
    at: Date.now(),
  };
}

function isAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<Annotation>;
  return typeof a.id === 'string'
    && typeof a.partId === 'string'
    && typeof a.text === 'string'
    && typeof a.at === 'number'
    && Array.isArray(a.local) && a.local.length === 3
    && a.local.every((n) => typeof n === 'number' && Number.isFinite(n));
}
