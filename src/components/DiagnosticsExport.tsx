import { useState } from 'react';
import { getActiveManager } from '../render/babylon/managerRegistry';
import { buildReport, capturedFrames } from '../diagnostics/report';
import { copyReport, exportReport } from '../diagnostics/export';
import { buildStamp } from '../diagnostics/build';
import { captureFrame } from '../diagnostics/capture';
import type { Capabilities } from '../engine/tracking/capabilities';

/**
 * One button instead of a round of screenshots.
 *
 * Everything this app knows about the session, in a file that can be sent: the
 * device, what the browser granted, what the session did or refused, and the
 * sequence of events with the errors in it.
 *
 * It lives here rather than inside the AR settings sheet because of the one
 * report that matters most and is hardest to get: an iPad inside the Needle Go
 * App Clip, where the AR bar has been seen not to appear at all. A log you can
 * only reach through chrome that is missing is a log nobody can send.
 */
export function DiagnosticsExport({ capabilities, inAr }: {
  capabilities: Capabilities | undefined;
  /** In AR there is a camera frame worth attaching; outside there is not. */
  inAr?: boolean;
}): JSX.Element {
  const [saved, setSaved] = useState<string | undefined>();
  const [text, setText] = useState<string | undefined>();

  return (
    <>
      <div className="ar-log-row">
        <button
          className="secondary"
          onClick={() => {
            void buildReport(capabilities)
              .then((report) => exportReport(report))
              .then((result) => setSaved(result.message))
              .catch((err) => setSaved(
                typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
                  // Cancelled, not failed — and emphatically not saved.
                  ? 'Sharing cancelled — nothing was saved'
                  : `Could not save the log: ${String(err)}`,
              ));
          }}
        >Save diagnostics log</button>
        {/* The route that needs nothing from the platform, offered next to the
            one that does — because a web view that ignores downloads reports
            no error at all, and there is no way to detect it beforehand. */}
        <button
          className="secondary"
          onClick={() => {
            void buildReport(capabilities)
              .then((report) => copyReport(report))
              .then((result) => { setText(result.text); setSaved(result.message); })
              .catch((err) => setSaved(`Could not read the log: ${String(err)}`));
          }}
        >Show the log as text</button>
        {inAr && (
          <button
            className="secondary"
            onClick={() => {
              const result = captureFrame(
                document.querySelector('video.passthrough'), getActiveManager(),
              );
              setSaved(result.ok
                ? `Frame attached (${capturedFrames().length} in the log)`
                : result.reason);
            }}
          >Attach a camera frame</button>
        )}
      </div>
      {saved && <p className="ar-set-help" role="status">{saved}</p>}
      {/* The last resort, and the reason there is one: a host that will neither
          save a file nor write the clipboard can still show the text. */}
      {text && (
        <textarea
          className="ar-log-text" readOnly value={text} spellCheck={false}
          aria-label="Diagnostics log, to select and copy"
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      {/* Which build this is, without exporting anything. A log arrived once
          from a bundle older than the change it was meant to test, and there
          was no way to tell that from the file. */}
      <p className="ar-set-help ar-build" role="status">
        Build {buildStamp().commit} · {buildStamp().at.slice(0, 16).replace('T', ' ')}
      </p>
    </>
  );
}
