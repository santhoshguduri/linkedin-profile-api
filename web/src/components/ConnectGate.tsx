/**
 * Shown in place of the search box until a LinkedIn session is available.
 *
 * Every lookup needs one, so without this the first search is guaranteed to come
 * back NOT_CONFIGURED — asking up front is kinder than letting someone paste a
 * URL, wait, and be told the thing they could not have known.
 */
export function ConnectGate({
  checking,
  serverOffline,
  onConnect,
}: {
  checking: boolean;
  serverOffline: boolean;
  onConnect: () => void;
}) {
  if (checking) {
    return (
      <section className="empty" aria-busy="true">
        <div className="spinner" aria-hidden="true" />
        <h2>Checking for a LinkedIn session&hellip;</h2>
      </section>
    );
  }

  if (serverOffline) {
    return (
      <section className="empty">
        <div className="empty-art" aria-hidden="true">&#9888;</div>
        <h2>Can&rsquo;t reach the API</h2>
        <p>
          The server is not responding. Start it with <code>npm run dev</code> in{' '}
          <code>server/</code>, then reload this page.
        </p>
      </section>
    );
  }

  return (
    <section className="empty connect-gate">
      <div className="empty-art" aria-hidden="true">&#128274;</div>
      <h2>Connect LinkedIn to start</h2>
      <p>
        Profiles are read as a signed-in member, so this API needs a LinkedIn session
        before it can look anything up. Sign in with your email and password, or paste
        a cookie header if you are already signed in elsewhere.
      </p>
      <button type="button" className="primary" onClick={onConnect}>
        Connect LinkedIn
      </button>
      <p className="note">
        Your session is kept in this browser tab only and cleared when the tab closes.
        Revoke it any time from LinkedIn&rsquo;s own device list.
      </p>
    </section>
  );
}
