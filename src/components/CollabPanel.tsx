import { useEffect, useRef, useState } from 'react';
import { CollabSession, createLoopbackSession } from '../engine/collab/session';
import { makeParticipant, type Participant, type SessionSnapshot } from '../engine/collab/protocol';

/**
 * The co-presence panel — the reason this beats a screen-sharing tool.
 *
 * Instead of streaming pixels, a remote expert joins the same spatial session:
 * poses, placements and annotations sync as a few hundred bytes a second, and
 * each participant renders the identical model against their own viewpoint. This
 * panel drives the session lifecycle and shows who is present; the annotations
 * and viewpoints themselves render in the 3D scene.
 */
export function CollabPanel(): JSX.Element {
  const [session, setSession] = useState<CollabSession>();
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [name] = useState(() => `Operator ${Math.floor(Math.random() * 90 + 10)}`);
  const expertRef = useRef<CollabSession | undefined>(undefined);

  const start = (): void => {
    const self: Participant = makeParticipant(name, 'operator');
    const s = createLoopbackSession('demo-room', self, setSnapshot);
    setSession(s);
    // Spin up a simulated remote expert so co-presence is visible in the demo.
    const expert = createLoopbackSession('demo-room', makeParticipant('Remote expert', 'expert'), () => undefined);
    expertRef.current = expert;
  };

  const leave = (): void => {
    session?.leave();
    expertRef.current?.leave();
    setSession(undefined);
    setSnapshot(undefined);
  };

  useEffect(() => () => { session?.leave(); expertRef.current?.leave(); }, [session]);

  return (
    <div className="collab">
      <h3>Spatial session</h3>
      {!session ? (
        <>
          <p className="hint">Invite a remote expert into the same AR space — no video, just shared geometry.</p>
          <button className="primary" onClick={start}>Start session</button>
        </>
      ) : (
        <>
          <ul className="participants">
            {(snapshot?.participants ?? []).map((p) => (
              <li key={p.id}>
                <span className="dot" style={{ background: p.color }} />
                {p.name} <span className="role">{p.role}</span>
              </li>
            ))}
          </ul>
          <p className="tiny">Session <code>demo-room</code> · pose &amp; annotation sync over data channel</p>
          <button className="ghost" onClick={leave}>Leave</button>
        </>
      )}
    </div>
  );
}
