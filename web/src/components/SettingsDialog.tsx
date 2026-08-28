import { useEffect, useRef, useState } from 'react';
import { apiKey, linkedInSession } from '../api';
import { onExtensionSession } from '../extensionBridge';

const EMPTY = { liAt: '', jsessionId: '', cookie: '' };

/**
 * Collects the two things the API may need from the visitor: an optional API key
 * for this deployment, and a LinkedIn session to run lookups as.
 *
 * There are three ways to hand over a session, in descending order of how much
 * the visitor has to understand:
 *
 *   1. The companion extension, which reads it from their own browser. This is
 *      how the commercial tools do it, and it is the only way that never puts a
 *      cookie in front of a person.
 *   2. Pasting the `Cookie:` header out of DevTools > Network. One copy, one
 *      paste; the server picks out the two values it needs.
 *   3. Typing li_at directly, for anyone who already knows what it is.
 *
 * An email and password is not among them. LinkedIn retired form-based sign-in:
 * its login page encrypts the password in the browser and attaches a device
 * fingerprint, so no server can sign in on a visitor's behalf. A cookie is also
 * the safer thing to hand over — one revocable session, not account control.
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
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      setKey(apiKey.get() ?? '');
      setFields({ ...EMPTY, ...linkedInSession.get() });
      setConnected(false);
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
    return onExtensionSession((session) => {
      setFields({ ...EMPTY, ...session });
      setConnected(true);
    });
  }, [open]);

  const update = (patch: Partial<typeof EMPTY>) => setFields((prev) => ({ ...prev, ...patch }));
  const hasSession = Boolean(fields.liAt.trim() || fields.cookie.trim());

  return (
    <dialog ref={ref} onClose={() => onClose(false)}>
      <form
        method="dialog"
        className="settings-form"
        onSubmit={(event) => {
          if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'save') {
            apiKey.set(key);
            linkedInSession.set(fields);
            onClose(true);
          } else {
            onClose(false);
          }
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
              {connected ? 'Received from extension' : 'Set'}
            </span>
          )}
        </div>
        <p>
          Optional. Runs lookups as you instead of as the server, so you are not spending someone
          else&rsquo;s rate limit. Kept in this tab only and cleared when the tab closes &mdash;
          never written to disk, never shared with another visitor.
        </p>

        <ol className="connect-steps">
          <li>
            Install the extension from the <code>extension/</code> folder of this repo &mdash;
            <code>chrome://extensions</code>, Developer mode, Load unpacked.
          </li>
          <li>
            Sign in to LinkedIn in this browser, then click the extension icon and press{' '}
            <strong>Send to this tab</strong>.
          </li>
        </ol>
        <p className="note">
          It has to be an extension rather than a bookmarklet: <code>li_at</code> is{' '}
          <code>HttpOnly</code>, so page scripts cannot read it and only the browser&rsquo;s cookie
          API can.
        </p>

        <details className="manual">
          <summary>No extension? Paste it instead</summary>
          <label className="field-label" htmlFor="li-cookie">
            Cookie header
          </label>
          <p>
            DevTools &rarr; Network &rarr; click any <code>linkedin.com</code> request &rarr; copy
            the <code>Cookie</code> request header and paste the whole thing. The server keeps{' '}
            <code>li_at</code> and <code>JSESSIONID</code> and discards everything else.
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
          Revoke it any time by signing that LinkedIn session out. Email and password are not
          accepted: LinkedIn encrypts the password in the browser and attaches a device
          fingerprint, so no server can sign in on your behalf.
        </p>

        <menu>
          <button value="clear" type="button" className="ghost" onClick={() => setFields(EMPTY)}>
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
