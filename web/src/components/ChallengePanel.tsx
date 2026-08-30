import { useEffect, useState } from 'react';
import type { ChallengeKind } from '../api';

/** Seconds since `since`, ticking. Only mounted while a challenge is open. */
function useElapsed(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

const mmss = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * What to do about an approval, spelled out.
 *
 * `unknown` gets the same steps as a recognised approval on purpose: it means
 * LinkedIn showed a screen this API could not name, and by far the most likely
 * thing behind it is an approval prompt worded unfamiliarly. Telling someone
 * that a step was "not recognised" and stopping there leaves them with nothing
 * to try; telling them to check their phone and their email costs nothing and
 * is usually right.
 */
function ApprovalSteps({ kind }: { kind: ChallengeKind }) {
  return (
    <ol className="approval-steps">
      <li>
        Open the <strong>LinkedIn app</strong> on your phone &mdash; the request arrives as a
        notification.
      </li>
      <li>
        Tap it and choose <strong>Yes, it&rsquo;s me</strong> to approve the sign-in.
      </li>
      {kind === 'unknown' && (
        <li>
          No notification? Check your email and text messages for a LinkedIn verification code, and
          enter it below instead.
        </li>
      )}
      <li>Come back to this tab. It picks the approval up on its own &mdash; nothing to press.</li>
    </ol>
  );
}

function CodeEntry({
  value,
  onChange,
  onSubmit,
  busy,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  busy: boolean;
  label?: string;
}) {
  return (
    <>
      {label && <p className="note code-label">{label}</p>}
      <div className="row">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Verification code"
          aria-label="Verification code"
        />
        <button
          type="button"
          className="primary"
          disabled={busy || !value.trim()}
          onClick={onSubmit}
        >
          {busy ? 'Checking…' : 'Submit'}
        </button>
      </div>
    </>
  );
}

/**
 * The verification step, while it is outstanding.
 *
 * A sign-in parked on an approval is not an error and must not read as one: the
 * server holds the browser open for five minutes and this tab polls it the whole
 * time, so the only honest controls are a code box and cancel. The elapsed
 * counter is there because a silent "waiting" gives no way to tell a live wait
 * from a hung one.
 */
export function ChallengePanel({
  kind,
  message,
  since,
  busy,
  code,
  onCode,
  onSubmitCode,
  onCancel,
}: {
  kind: ChallengeKind;
  message: string;
  since: number;
  busy: boolean;
  code: string;
  onCode: (next: string) => void;
  onSubmitCode: () => void;
  onCancel: () => void;
}) {
  const elapsed = useElapsed(since);

  return (
    <div className="challenge">
      <p className="challenge-message">{message}</p>

      {kind === 'code' ? (
        <CodeEntry value={code} onChange={onCode} onSubmit={onSubmitCode} busy={busy} />
      ) : (
        <>
          <ApprovalSteps kind={kind} />
          <p className="waiting" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            Waiting for approval &mdash; {mmss(elapsed)}
          </p>
          {kind === 'unknown' && (
            <CodeEntry
              value={code}
              onChange={onCode}
              onSubmit={onSubmitCode}
              busy={busy}
              label="Got a code instead of a notification?"
            />
          )}
        </>
      )}

      <p className="note">
        This stays open for five minutes. Cancelling closes the browser the sign-in is running in.
      </p>
      <button type="button" className="ghost" onClick={onCancel}>
        Cancel sign-in
      </button>
    </div>
  );
}
