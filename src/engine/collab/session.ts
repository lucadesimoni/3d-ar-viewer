import type { Pose } from '../types';
import {
  PROTOCOL_VERSION,
  emptySnapshot,
  pruneSnapshot,
  reduce,
  type Annotation,
  type ClientMessage,
  type Participant,
  type SessionSnapshot,
} from './protocol';

/**
 * A transport is anything that can post a message and deliver messages back.
 *
 * The app ships a loopback transport (below) for a co-located demo and for
 * tests; a production deployment plugs in a WebRTC data channel or a WebSocket
 * relay behind the exact same three methods. Nothing above this line knows or
 * cares which is in use.
 */
export interface Transport {
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ClientMessage) => void): void;
  close(): void;
}

/**
 * In-process transport that fans every message out to its peers.
 *
 * Handy for a two-pane demo in one browser tab, and it is what the protocol
 * tests run against so they never touch the network.
 */
export class LoopbackTransport implements Transport {
  private static buses = new Map<string, Set<LoopbackTransport>>();
  private handler: ((msg: ClientMessage) => void) | undefined;

  constructor(private readonly channel: string) {
    const set = LoopbackTransport.buses.get(channel) ?? new Set();
    set.add(this);
    LoopbackTransport.buses.set(channel, set);
  }

  send(msg: ClientMessage): void {
    for (const peer of LoopbackTransport.buses.get(this.channel) ?? []) {
      if (peer !== this) peer.handler?.(msg);
    }
  }

  onMessage(handler: (msg: ClientMessage) => void): void {
    this.handler = handler;
  }

  close(): void {
    LoopbackTransport.buses.get(this.channel)?.delete(this);
  }
}

export interface CollabSessionOptions {
  sessionId: string;
  self: Participant;
  transport: Transport;
  /** Called on every snapshot change so the UI can re-render. */
  onChange: (snapshot: SessionSnapshot) => void;
  /** Heartbeat/prune period, ms. */
  tickMs?: number;
}

/**
 * Client-side session: owns the shared snapshot, applies incoming messages, and
 * throttles the chatty outbound ones (viewpoint especially) so a moving camera
 * cannot saturate a thin link.
 */
export class CollabSession {
  snapshot: SessionSnapshot;
  readonly self: Participant;

  private transport: Transport;
  private onChange: (s: SessionSnapshot) => void;
  private timestamps = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastViewpointSentMs = 0;

  constructor(opts: CollabSessionOptions) {
    this.snapshot = emptySnapshot(opts.sessionId);
    this.self = opts.self;
    this.transport = opts.transport;
    this.onChange = opts.onChange;

    this.transport.onMessage((msg) => this.receive(msg));
    this.snapshot.participants = [this.self];
    this.transport.send({ t: 'hello', v: PROTOCOL_VERSION, participant: this.self });

    const tick = opts.tickMs ?? 4000;
    this.timer = setInterval(() => this.heartbeat(), tick);
  }

  private receive(msg: ClientMessage): void {
    if (msg.t === 'hello' && msg.v !== PROTOCOL_VERSION) {
      // Version skew: keep the participant listed but flag it for the UI to warn.
      msg.participant.name = `${msg.participant.name} (needs update)`;
    }
    if (msg.t === 'ping') {
      this.transport.send({ t: 'pong', ts: msg.ts });
      return;
    }
    this.touch(msg);
    this.snapshot = reduce(this.snapshot, msg, this.timestamps);
    this.onChange(this.snapshot);
  }

  /** Refresh a participant's lastSeen from any message they send. */
  private touch(msg: ClientMessage): void {
    const id = 'id' in msg ? msg.id : 'authorId' in msg ? msg.authorId : undefined;
    if (!id) return;
    const p = this.snapshot.participants.find((x) => x.id === id);
    if (p) p.lastSeenMs = Date.now();
  }

  private heartbeat(): void {
    this.transport.send({ t: 'ping', ts: Date.now() });
    const before = this.snapshot.participants.length;
    this.snapshot = pruneSnapshot(this.snapshot);
    if (this.snapshot.participants.length !== before) this.onChange(this.snapshot);
  }

  /** Local mutation + broadcast in one call, so the sender sees its own change immediately. */
  private local(msg: ClientMessage): void {
    this.snapshot = reduce(this.snapshot, msg, this.timestamps);
    this.transport.send(msg);
    this.onChange(this.snapshot);
  }

  setAnchor(pose: Pose, quality: number): void {
    this.local({ t: 'anchor', pose, quality, ts: Date.now() });
  }

  setPlacement(partId: string, pose: Pose, status: 'ghost' | 'placed' | 'verified'): void {
    this.local({ t: 'placement', partId, pose, status, ts: Date.now() });
  }

  setStep(activeStepId: string | undefined, completed: string[]): void {
    this.local({ t: 'step', activeStepId, completed, ts: Date.now() });
  }

  /** Viewpoints are throttled: at most one every ~100 ms regardless of frame rate. */
  sendViewpoint(pose: Pose): void {
    const now = Date.now();
    if (now - this.lastViewpointSentMs < 100) return;
    this.lastViewpointSentMs = now;
    this.transport.send({ t: 'viewpoint', id: this.self.id, pose, ts: now });
  }

  annotate(annotation: Annotation): void {
    this.local({ t: 'annotate', annotation });
  }

  clearAnnotations(opts: { id?: string; authorId?: string } = {}): void {
    this.local({ t: 'annotate.clear', ...opts });
  }

  chat(text: string): void {
    this.transport.send({
      t: 'chat',
      id: `${this.self.id}-${Date.now()}`,
      authorId: this.self.id,
      text,
      ts: Date.now(),
    });
  }

  leave(): void {
    this.transport.send({ t: 'bye', id: this.self.id });
    if (this.timer) clearInterval(this.timer);
    this.transport.close();
  }
}

/** Convenience factory for the co-located demo mode. */
export function createLoopbackSession(
  channel: string,
  self: Participant,
  onChange: (s: SessionSnapshot) => void,
): CollabSession {
  return new CollabSession({
    sessionId: channel,
    self,
    transport: new LoopbackTransport(channel),
    onChange,
  });
}
