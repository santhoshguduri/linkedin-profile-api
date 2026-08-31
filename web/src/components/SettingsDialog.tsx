import { useCallback, useEffect, useRef, useState } from 'react';
import { linkedInSession, type LinkedInSession } from '../api';
import { onExtensionSession } from '../extensionBridge';
import { useSignIn } from '../useSignIn';
import { ChallengePanel } from './ChallengePanel';

const EMPTY = { liAt: '', jsessionId: '', cookie: '', userAgent: '' };

/**
 * Collects the LinkedIn session that lookups run as.
 *
 * Two ways to hand one over:
 *
 *   1. Email and password. The server drives a real browser through LinkedIn's
 *      sign-in, waits out whatever verification LinkedIn asks for, and keeps
 *      only the resulting cookie.
 *   2. Pasting a cookie header, for anyone already signed in elsewhere who would
 *      rather not type a password here.
 *
 * Both end in the same place: a `li_at` cookie held in this tab and sent with
 * each lookup. The password is used once and kept nowhere.
 *
 * There is no Save button, and that is the point. A sign-in that succeeded has
 * nothing left to confirm -- the session is already in hand -- so a Save step
 * only stood between it and the search box, and a Cancel next to it invited
 * throwing away a sign-in that had already happened. A session arriving closes
 * the dialog. The only buttons left are the ones that start something.
 *
 * The companion extension still pushes a session if it is installed -- the
 * listener below is unconditional -- it is simply no longer advertised here.
 */
export function SettingsDialog({
  open,
  onClose,
  passwordLogin = true,
}: {
  open: boolean;
  onClose: (changed: boolean) => void;
  /**
   * Whether the API can actually sign someone in, from `/api/status`.
   *
   * False on a deployment with no browser -- a serverless function, a Node
   * buildpack -- where the sign-in exists as a route but cannot run. Offering
   * the form there spends a password to earn a 501, so the cookie path is shown
   * on its own instead. Defaults true so the form survives an unreachable
   * status call rather than vanishing on a transient error.
   */
  passwordLogin?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [fields, setFields] = useState(EMPTY);
  const [login, setLogin] = useState({ username: '', password: '', code: '' });
  /** Whether a session was already stored when the dialog opened. */
  const [connected, setConnected] = useState(false);
  /** Closing a <dialog> fires its own close event, so the outcome is latched. */
  const reported = useRef(false);

  const close = useCallback(
    (changed: boolean) => {
      if (reported.current) return;
      reported.current = true;
      onClose(changed);
    },
    [onClose],
  );

  /** A session arrived, from whichever route. Store it and get out of the way. */
  const accept = useCallback(
    (session: LinkedInSession) => {
      linkedInSession.set(session);
      close(true);
    },
    [close],
  );

  const { state, start, submitCode, reset } = useSignIn(accept);

  /** Dismissal. Also abandons a parked sign-in, so its browser is freed. */
  const dismiss = useCallback(() => {
    reset();
    close(false);
  }, [reset, close]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      const stored = linkedInSession.get();
      setFields({ ...EMPTY, ...stored });
      setConnected(stored !== null);
      reported.current = false;
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  /**
   * The extension pushes rather than being polled, so the dialog just listens
   * while it is open. It lands in the same place a sign-in does.
   */
  useEffect(() => {
    if (!open) return;
    return onExtensionSession(accept);
  }, [open, accept]);

  const update = (patch: Partial<typeof EMPTY>) => setFields((prev) => ({ ...prev, ...patch }));
  const hasSession = Boolean(fields.liAt.trim() || fields.cookie.trim());
  const busy = state.phase === 'working' || (state.phase === 'challenge' && state.busy);

  return (
    <dialog ref={ref} onClose={dismiss}>
      {/*
        Still a <form>, with no submit buttons in its footer: it is what makes
        Enter in the cookie fields mean "use this", rather than the browser's
        implicit submit closing the dialog and dropping what was typed.
      */}
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          linkedInSession.set(fields);
          close(true);
        }}
      >
        <div className="dialog-head">
          <h2>Connect LinkedIn</h2>
          <button type="button" className="icon-button" onClick={dismiss} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="section-head">
          <span className="field-label">Your LinkedIn session</span>
          {connected && (
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                linkedInSession.set(null);
                close(true);
              }}
            >
              Disconnect
            </button>
          )}
        </div>
        <p>
          Runs lookups as you rather than as the server. Kept in this tab only and cleared when the
          tab closes &mdash; never written to disk, never shared with another visitor.
        </p>

        {state.phase === 'challenge' ? (
          <ChallengePanel
            kind={state.kind}
            message={state.message}
            since={state.since}
            busy={busy}
            code={login.code}
            onCode={(code) => setLogin({ ...login, code })}
            onSubmitCode={() => void submitCode(login.code)}
            onCancel={dismiss}
          />
        ) : !passwordLogin ? (
          <p className="note" role="status">
            This deployment cannot sign you in: it has no browser to drive LinkedIn&rsquo;s login
            page with. Paste your cookie below instead &mdash; it reaches the same place, and it is
            the route the hosted API expects.
          </p>
        ) : (
          <div className="signin">
            <input
              type="email"
              autoComplete="username"
              value={login.username}
              onChange={(e) => setLogin({ ...login, username: e.target.value })}
              placeholder="LinkedIn email"
              aria-label="LinkedIn email"
            />
            <input
              type="password"
              autoComplete="current-password"
              value={login.password}
              onChange={(e) => setLogin({ ...login, password: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void start(login.username, login.password);
                }
              }}
              placeholder="Password"
              aria-label="LinkedIn password"
            />
            <button
              type="button"
              className="primary"
              disabled={busy || !login.username.trim() || !login.password}
              onClick={() => void start(login.username, login.password)}
            >
              {busy ? 'Signing in…' : 'Sign in to LinkedIn'}
            </button>
            {state.phase === 'working' ? (
              // The server holds this request open for up to twenty seconds so an
              // approval tapped quickly resolves without a second round trip. That
              // is a long time to watch a disabled button with no explanation.
              <p className="note" aria-live="polite">
                Signing in through a real browser, which takes a few seconds. If LinkedIn wants you
                to approve this, the request is on its way to the LinkedIn app on your phone
                &mdash; keep it handy.
              </p>
            ) : (
              <p className="note">
                LinkedIn may ask you to approve this from the LinkedIn app on your phone. Your
                password goes to the API once and is not stored; only the session cookie it returns
                is kept, and only in this tab.
              </p>
            )}
          </div>
        )}

        {state.phase === 'error' && (
          <p className="error" role="alert">
            {state.message}
            {state.hint && <span className="note"> {state.hint}</span>}
          </p>
        )}

        <details className="manual">
          <summary>Already signed in to LinkedIn here? Skip the password</summary>

          <label className="field-label" htmlFor="li-cookie">
            Paste the cookie header
          </label>
          <p>
            DevTools &rarr; Network &rarr; click any <code>linkedin.com</code> request &rarr; copy
            the <code>Cookie</code> request header. The server keeps <code>li_at</code> and{' '}
            <code>JSESSIONID</code> and discards everything else.
          </p>
          <input
            id="li-at"
            type="password"
            value={fields.liAt}
            onChange={(e) => update({ liAt: e.target.value, cookie: '' })}
            placeholder="li_at cookie"
            autoComplete="off"
          />

          {/* The one submit button in the dialog: a pasted cookie is the only
              route that needs a deliberate press, because nothing announces it
              the way a completed sign-in does. */}
          <button type="submit" className="primary manual-save" disabled={!hasSession}>
            Use this cookie
          </button>
        </details>

        <p className="note">
          Revoke access at any time by signing that LinkedIn session out from LinkedIn&rsquo;s own
          device list.
        </p>
      </form>
    </dialog>
  );
}
