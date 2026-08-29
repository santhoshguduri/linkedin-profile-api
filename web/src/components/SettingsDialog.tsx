import { useCallback, useEffect, useRef, useState } from 'react';
import { apiKey, linkedInSession, type LinkedInSession } from '../api';
import { onExtensionSession } from '../extensionBridge';
import { useSignIn } from '../useSignIn';

const EMPTY = { liAt: '', jsessionId: '', cookie: '' };

/**
 * Collects the two things the API may need from the visitor: an optional API key
 * for this deployment, and a LinkedIn session to run lookups as.
 *
 * Three ways to hand over a session, in descending order of how much the visitor
 * has to understand:
 *
 *   1. Email and password. The server drives a real browser through LinkedIn's
 *      sign-in, waits out whatever verification LinkedIn asks for, and keeps
 *      only the resulting cookie.
 *   2. The companion extension, which lifts the cookie from a browser already
 *      signed in. Nothing to type and no verification, because the sign-in
 *      already happened.
 *   3. Pasting the cookie, for anyone who would rather not do either.
 *
 * All three end in the same place: a `li_at` cookie held in this tab and sent
 * with each lookup. The password is used once and kept nowhere.
 */
export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: (saved: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState('');
  const [fields, setFields] = useState(EMPTY);
  const [source, setSource] = useState<'extension' | 'sign-in' | null>(null);
  const [login, setLogin] = useState({ username: '', password: '', code: '' });

  const adopt = useCallback((session: LinkedInSession, from: 'extension' | 'sign-in') => {
    setFields({ ...EMPTY, ...session });
    setSource(from);
  }, []);

  const onSignedIn = useCallback(
    (session: LinkedInSession) => {
      adopt(session, 'sign-in');
      setLogin({ username: '', password: '', code: '' });
    },
    [adopt],
  );

  const { state, start, submitCode, reset } = useSignIn(onSignedIn);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      setKey(apiKey.get() ?? '');
      setFields({ ...EMPTY, ...linkedInSession.get() });
      setSource(null);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  /**
   * The extension pushes rather than being polled, so the dialog just listens
   * while it is open. Saving still needs a deliberate press — a session that
   * arrives is filled in, not committed behind the visitor's back.
   */
  useEffect(() => {
    if (!open) return;
    return onExtensionSession((session) => adopt(session, 'extension'));
  }, [open, adopt]);

  const update = (patch: Partial<typeof EMPTY>) => setFields((prev) => ({ ...prev, ...patch }));
  const hasSession = Boolean(fields.liAt.trim() || fields.cookie.trim());
  const busy = state.phase === 'working' || (state.phase === 'challenge' && state.busy);

  const finish = (saved: boolean) => {
    reset();
    onClose(saved);
  };

  return (
    <dialog ref={ref} onClose={() => finish(false)}>
      <form
        method="dialog"
        className="settings-form"
        onSubmit={(event) => {
          const saving =
            (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'save';
          if (saving) {
            apiKey.set(key);
            linkedInSession.set(fields);
          }
          finish(saving);
        }}
      >
        <h2>Settings</h2>

        <label className="field-label" htmlFor="api-key">
          API key
        </label>
        <p>
          Sent as <code>x-api-key</code>. Leave blank if the API is open.
        </p>
        <input
          id="api-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
        />

        <hr />

        <div className="section-head">
          <span className="field-label">Your LinkedIn session</span>
          {hasSession && (
            <span className="badge badge--ok">
              {source === 'sign-in'
                ? 'Signed in'
                : source === 'extension'
                  ? 'Received from extension'
                  : 'Set'}
            </span>
          )}
        </div>
        <p>
          Runs lookups as you rather than as the server. Kept in this tab only and cleared when the
          tab closes &mdash; never written to disk, never shared with another visitor.
        </p>

        {state.phase === 'challenge' ? (
          <div className="challenge">
            <p className="challenge-message">{state.message}</p>

            {state.kind === 'app-approval' ? (
              // Nothing to press: the poll in useSignIn resolves this as soon as
              // the notification is tapped, so the only honest control is cancel.
              <p className="note" aria-live="polite">
                Waiting for you to approve it&hellip;
              </p>
            ) : (
              <div className="row">
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={login.code}
                  onChange={(e) => setLogin({ ...login, code: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void submitCode(login.code);
                    }
                  }}
                  placeholder="Verification code"
                  aria-label="Verification code"
                />
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !login.code.trim()}
                  onClick={() => void submitCode(login.code)}
                >
                  {busy ? 'Checking…' : 'Submit'}
                </button>
              </div>
            )}

            <button type="button" className="ghost" onClick={reset}>
              Cancel sign-in
            </button>
          </div>
        ) : (
          // Not a nested <form>: this dialog already is one, and the buttons
          // below submit it. Enter is wired up by hand instead.
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
            <p className="note">
              LinkedIn may ask you to approve this from the LinkedIn app on your phone. Your
              password goes to the API once and is not stored; only the session cookie it returns
              is kept, and only in this tab.
            </p>
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
          <ol className="connect-steps">
            <li>
              Install the extension from the <code>extension/</code> folder of this repo &mdash;
              <code>chrome://extensions</code>, Developer mode, Load unpacked.
            </li>
            <li>
              Click the extension icon and press <strong>Send to this tab</strong>.
            </li>
          </ol>
          <p className="note">
            It has to be an extension rather than a bookmarklet: <code>li_at</code> is{' '}
            <code>HttpOnly</code>, so page scripts cannot read it and only the browser&rsquo;s
            cookie API can.
          </p>

          <label className="field-label" htmlFor="li-cookie">
            Or paste the cookie header
          </label>
          <p>
            DevTools &rarr; Network &rarr; click any <code>linkedin.com</code> request &rarr; copy
            the <code>Cookie</code> request header. The server keeps <code>li_at</code> and{' '}
            <code>JSESSIONID</code> and discards everything else.
          </p>
          <textarea
            id="li-cookie"
            value={fields.cookie}
            onChange={(e) => update({ cookie: e.target.value, liAt: '', jsessionId: '' })}
            placeholder="bcookie=v=2&...; li_at=AQEDAT...; JSESSIONID=&quot;ajax:123&quot;; lidc=..."
            rows={3}
            autoComplete="off"
            spellCheck={false}
          />

          <label className="field-label" htmlFor="li-at">
            Or the values on their own
          </label>
          <input
            id="li-at"
            type="password"
            value={fields.liAt}
            onChange={(e) => update({ liAt: e.target.value, cookie: '' })}
            placeholder="li_at cookie"
            autoComplete="off"
          />
          <input
            type="password"
            value={fields.jsessionId}
            onChange={(e) => update({ jsessionId: e.target.value, cookie: '' })}
            placeholder="JSESSIONID (optional)"
            autoComplete="off"
          />
        </details>

        <p className="note">
          Revoke access at any time by signing that LinkedIn session out from LinkedIn&rsquo;s own
          device list.
        </p>

        <menu>
          <button
            value="clear"
            type="button"
            className="ghost"
            onClick={() => {
              setFields(EMPTY);
              setSource(null);
            }}
          >
            Clear
          </button>
          <button value="cancel" className="ghost" type="submit">
            Cancel
          </button>
          <button value="save" type="submit" className="primary">
            Save
          </button>
        </menu>
      </form>
    </dialog>
  );
}
