/**
 * Wire protocol for a shared AR session.
 *
 * The premise that lets this beat a screen-share tool like TeamViewer: we never
 * ship pixels. A remote expert does not watch a 30 fps H.264 stream of a shaking
 * tablet — they join the *same spatial session*. Both ends render the identical
 * assembly locally against their own view, and all that crosses the wire is a
 * few hundred bytes of pose, placement, and annotation state per second. That is
 * why it stays usable on a factory-floor cellular link where video collapses,
 * and why the expert can look around the assembly independently of where the
 * operator happens to be pointing the camera.
 *
 * The transport is deliberately abstracted (see `session.ts`): the same messages
 * ride WebRTC data channels, a WebSocket relay, or a loopback for tests.
 */

import type { Diagnostic } from '../diagnostics';
import type { Pose, Vec3 } from '../types';

export const PROTOCOL_VERSION = 1;

export type Role = 'operator' | 'expert' | 'observer';

export interface Participant {
  id: string;
  name: string;
  role: Role;
  color: string;
  /** Last time a message was seen from them, epoch ms. */
  lastSeenMs: number;
}

/** A pointer the expert casts into the operator's space to indicate a feature. */
export interface Annotation {
  id: string;
  authorId: string;
  kind: 'arrow' | 'circle' | 'label' | 'path';
  /** Points in the assembly frame — they stay glued to the workpiece, not the screen. */
  points: Vec3[];
  color: string;
  text?: string;
  /** Auto-expire so stale marks do not pile up on the part. */
  expiresAtMs?: number;
  createdAtMs: number;
}

export type ClientMessage =
  | { t: 'hello'; v: number; participant: Participant }
  | { t: 'bye'; id: string }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number }
  /** Head/device pose so everyone sees everyone else's viewpoint as a frustum. */
  | { t: 'viewpoint'; id: string; pose: Pose; ts: number }
  /** The operator's registration — where the assembly sits in the shared frame. */
  | { t: 'anchor'; pose: Pose; quality: number; ts: number }
  /** A part was moved/placed/verified. Deltas, not the whole model. */
  | { t: 'placement'; partId: string; pose: Pose; status: 'ghost' | 'placed' | 'verified'; ts: number }
  | { t: 'step'; activeStepId: string | undefined; completed: string[]; ts: number }
  | { t: 'annotate'; annotation: Annotation }
  | { t: 'annotate.clear'; id?: string; authorId?: string }
  /** Expert asks the operator's view to focus a part (draws a locator, no camera hijack). */
  | { t: 'focus'; partId: string; authorId: string; ts: number }
  | { t: 'diagnostics'; items: Diagnostic[]; ts: number }
  | { t: 'chat'; id: string; authorId: string; text: string; ts: number };

export interface SessionSnapshot {
  sessionId: string;
  participants: Participant[];
  anchor?: { pose: Pose; quality: number };
  placements: Record<string, { pose: Pose; status: 'ghost' | 'placed' | 'verified' }>;
  activeStepId?: string;
  completedStepIds: string[];
  annotations: Annotation[];
}

const PALETTE = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185'];

/** Stable per-participant colour so a teammate keeps the same tint all session. */
export function colorForParticipant(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function makeParticipant(name: string, role: Role): Participant {
  const id = `${role}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, name, role, color: colorForParticipant(id), lastSeenMs: Date.now() };
}

/**
 * Fold an incoming message into a snapshot.
 *
 * Kept pure and framework-free so it is trivially testable and can run on a relay
 * server as the authority as easily as in the browser. Out-of-order messages are
 * tolerated: per-part and per-viewpoint updates carry timestamps and an older one
 * never clobbers a newer one.
 */
export function reduce(
  snapshot: SessionSnapshot,
  msg: ClientMessage,
  timestamps: Map<string, number> = new Map(),
): SessionSnapshot {
  switch (msg.t) {
    case 'hello': {
      const others = snapshot.participants.filter((p) => p.id !== msg.participant.id);
      return { ...snapshot, participants: [...others, msg.participant] };
    }
    case 'bye':
      return {
        ...snapshot,
        participants: snapshot.participants.filter((p) => p.id !== msg.id),
      };
    case 'anchor': {
      const key = 'anchor';
      if ((timestamps.get(key) ?? 0) > msg.ts) return snapshot;
      timestamps.set(key, msg.ts);
      return { ...snapshot, anchor: { pose: msg.pose, quality: msg.quality } };
    }
    case 'placement': {
      const key = `part:${msg.partId}`;
      if ((timestamps.get(key) ?? 0) > msg.ts) return snapshot;
      timestamps.set(key, msg.ts);
      return {
        ...snapshot,
        placements: {
          ...snapshot.placements,
          [msg.partId]: { pose: msg.pose, status: msg.status },
        },
      };
    }
    case 'step': {
      if ((timestamps.get('step') ?? 0) > msg.ts) return snapshot;
      timestamps.set('step', msg.ts);
      return { ...snapshot, activeStepId: msg.activeStepId, completedStepIds: msg.completed };
    }
    case 'annotate': {
      const others = snapshot.annotations.filter((a) => a.id !== msg.annotation.id);
      return { ...snapshot, annotations: [...others, msg.annotation] };
    }
    case 'annotate.clear':
      return {
        ...snapshot,
        annotations: snapshot.annotations.filter((a) => {
          if (msg.id) return a.id !== msg.id;
          if (msg.authorId) return a.authorId !== msg.authorId;
          return false;
        }),
      };
    default:
      return snapshot;
  }
}

/** Remove participants and annotations that have gone stale. */
export function pruneSnapshot(snapshot: SessionSnapshot, nowMs = Date.now(), staleMs = 15000): SessionSnapshot {
  return {
    ...snapshot,
    participants: snapshot.participants.filter((p) => nowMs - p.lastSeenMs < staleMs),
    annotations: snapshot.annotations.filter((a) => !a.expiresAtMs || a.expiresAtMs > nowMs),
  };
}

export function emptySnapshot(sessionId: string): SessionSnapshot {
  return {
    sessionId,
    participants: [],
    placements: {},
    completedStepIds: [],
    annotations: [],
  };
}
