import { describe, expect, it } from 'vitest';
import { emptySnapshot, makeParticipant, pruneSnapshot, reduce } from './protocol';

describe('reduce', () => {
  it('adds and removes participants on hello/bye', () => {
    let snap = emptySnapshot('room');
    const p = makeParticipant('Sam', 'expert');
    snap = reduce(snap, { t: 'hello', v: 1, participant: p });
    expect(snap.participants).toHaveLength(1);
    snap = reduce(snap, { t: 'bye', id: p.id });
    expect(snap.participants).toHaveLength(0);
  });

  it('keeps the newest placement when messages arrive out of order', () => {
    const ts = new Map<string, number>();
    let snap = emptySnapshot('room');
    const pose = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
    snap = reduce(snap, { t: 'placement', partId: 'x', pose, status: 'verified', ts: 100 }, ts);
    // An older update for the same part must not overwrite the newer one.
    const older = { position: [9, 9, 9] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
    snap = reduce(snap, { t: 'placement', partId: 'x', pose: older, status: 'placed', ts: 50 }, ts);
    expect(snap.placements.x.pose.position).toEqual([1, 2, 3]);
    expect(snap.placements.x.status).toBe('verified');
  });

  it('clears annotations by author', () => {
    let snap = emptySnapshot('room');
    const a = { id: 'a1', authorId: 'e1', kind: 'arrow' as const, points: [], color: '#fff', createdAtMs: 0 };
    snap = reduce(snap, { t: 'annotate', annotation: a });
    expect(snap.annotations).toHaveLength(1);
    snap = reduce(snap, { t: 'annotate.clear', authorId: 'e1' });
    expect(snap.annotations).toHaveLength(0);
  });
});

describe('pruneSnapshot', () => {
  it('drops stale participants and expired annotations', () => {
    let snap = emptySnapshot('room');
    const p = makeParticipant('Old', 'observer');
    p.lastSeenMs = Date.now() - 60000;
    snap.participants.push(p);
    snap.annotations.push({ id: 'x', authorId: p.id, kind: 'label', points: [], color: '#fff', createdAtMs: 0, expiresAtMs: Date.now() - 1000 });
    const pruned = pruneSnapshot(snap);
    expect(pruned.participants).toHaveLength(0);
    expect(pruned.annotations).toHaveLength(0);
  });
});
