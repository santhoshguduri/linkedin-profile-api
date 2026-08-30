import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE, fetchStatus, linkedInSession, type ServerStatus } from './api';
import { useProfileLookup } from './useProfileLookup';
import { SearchBar } from './components/SearchBar';
import { MetaStrip } from './components/MetaStrip';
import { ProfileView } from './components/ProfileView';
import { JsonView } from './components/JsonView';
import { ErrorPanel } from './components/ErrorPanel';
import { Skeleton } from './components/Skeleton';
import { SettingsDialog } from './components/SettingsDialog';
import { ConnectGate } from './components/ConnectGate';

type Tab = 'profile' | 'json';

/** Failures the visitor can resolve by supplying their own LinkedIn session. */
const NEEDS_SESSION = new Set([
  'NOT_CONFIGURED',
  'SESSION_INVALID',
  'CHALLENGE_REQUIRED',
  'LOGIN_UNSUPPORTED',
]);

export function App() {
  const initialUrl = new URLSearchParams(window.location.search).get('url') ?? '';
  const [url, setUrl] = useState(initialUrl);
  const [refresh, setRefresh] = useState(false);
  const [tab, setTab] = useState<Tab>('profile');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [note, setNote] = useState<string>('');
  /** Bumped when the session changes, so the gate and footer re-read it. */
  const [sessionRevision, setSessionRevision] = useState(0);
  /** Guards the ?url= autorun so it fires once, not on every status refresh. */
  const [autoRan, setAutoRan] = useState(false);
  /** Distinguishes "still asking the server" from "asked, and it is down". */
  const [checkedOnce, setCheckedOnce] = useState(false);

  const { state, run } = useProfileLookup();

  const submit = useCallback(
    (value: string) => {
      void run(value, refresh);
    },
    [run, refresh],
  );

  // Re-read on every lookup and after Settings saves, so connecting immediately
  // opens the search rather than needing a reload.
  useEffect(() => {
    let live = true;
    fetchStatus()
      .then((next) => live && setStatus(next))
      .catch(() => live && setStatus(null))
      .finally(() => live && setCheckedOnce(true));
    return () => {
      live = false;
    };
  }, [state.status, sessionRevision]);

  const result = state.status === 'success' ? state.data : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ownSession = useMemo(() => linkedInSession.get() !== null, [sessionRevision]);

  /**
   * A session exists, from either side.
   *
   * `sessionReady` rather than `credentialsConfigured`: a server holding only an
   * email and password has the means to sign in but not a session yet, and that
   * sign-in can stop for a phone approval. Treating it as connected would put
   * the visitor back in the failure this gate exists to prevent.
   */
  const connected = ownSession || status?.sessionReady === true;
  const checking = status === null && !ownSession && !checkedOnce;

  // A ?url= in the address bar runs on load, so a result can be shared as a
  // link -- but only once there is a session to run it with.
  useEffect(() => {
    if (!initialUrl || autoRan || !connected) return;
    setAutoRan(true);
    void run(initialUrl, false);
  }, [initialUrl, autoRan, connected, run]);

  const copy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setNote('JSON copied to clipboard');
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), {
      href,
      download: `${result.profile.publicIdentifier}.json`,
    });
    link.click();
    URL.revokeObjectURL(href);
  };

  return (
    <>
      <div className="aurora" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">in</span>
          <div>
            <h1>Profile API</h1>
            <p>LinkedIn profile URL &rarr; structured JSON</p>
          </div>
        </div>
        <nav className="topbar-actions">
          <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <a className="ghost" href={API_BASE} target="_blank" rel="noopener noreferrer">
            API
          </a>
        </nav>
      </header>

      <main>
        {!connected ? (
          <ConnectGate
            checking={checking}
            serverOffline={status === null && checkedOnce}
            onConnect={() => setSettingsOpen(true)}
          />
        ) : (
          <>
        <SearchBar
          url={url}
          onUrlChange={setUrl}
          refresh={refresh}
          onRefreshChange={setRefresh}
          onSubmit={submit}
          busy={state.status === 'loading'}
        />

        {state.status === 'error' && (
          <ErrorPanel
            code={state.error.code}
            message={state.error.message}
            hint={state.error.hint}
            retryAfterSeconds={state.error.retryAfterSeconds}
            action={
              NEEDS_SESSION.has(state.error.code)
                ? { label: 'Use my LinkedIn session', onClick: () => setSettingsOpen(true) }
                : undefined
            }
          />
        )}

        {state.status === 'loading' && <Skeleton stage={state.stage} />}

        {state.status === 'idle' && (
          <section className="empty">
            <div className="empty-art" aria-hidden="true">
              &#128279;
            </div>
            <h2>Paste a profile URL to begin</h2>
            <p>
              Full URLs, locale subdomains (<code>in.linkedin.com</code>), <code>/details/</code>{' '}
              sub-routes and bare public identifiers all work.
            </p>
          </section>
        )}

        {result && (
          <section>
            <MetaStrip meta={result.meta} />

            <div className="tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'profile'}
                className={`tab${tab === 'profile' ? ' active' : ''}`}
                onClick={() => setTab('profile')}
              >
                Profile
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'json'}
                className={`tab${tab === 'json' ? ' active' : ''}`}
                onClick={() => setTab('json')}
              >
                JSON
              </button>
              <div className="tab-actions">
                <button type="button" className="ghost" onClick={() => void copy()}>
                  Copy JSON
                </button>
                <button type="button" className="ghost" onClick={download}>
                  Download
                </button>
              </div>
            </div>

            {tab === 'profile' ? (
              <ProfileView profile={result.profile} />
            ) : (
              <JsonView value={result} />
            )}
          </section>
        )}
          </>
        )}
      </main>

      <footer>
        {note ||
          footerText(
            status,
            ownSession,
            state.status === 'success' ? state.roundTripMs : null,
          )}
      </footer>

      <SettingsDialog
        open={settingsOpen}
        onClose={(changed) => {
          setSettingsOpen(false);
          // Covers connecting and disconnecting alike -- both change which
          // session the next lookup runs as, and both need the gate re-read.
          if (changed) {
            setSessionRevision((n) => n + 1);
            setNote(linkedInSession.get() ? 'LinkedIn connected for this tab' : 'LinkedIn disconnected');
          }
        }}
      />
    </>
  );
}

/**
 * The footer doubles as a deployment health line. A server with no session of
 * its own is only a problem when the visitor has not supplied one either, so the
 * warning is suppressed once they have.
 */
function footerText(
  status: ServerStatus | null,
  ownSession: boolean,
  roundTripMs: number | null,
): string {
  if (status === null) return 'Status unavailable';

  if (!status.credentialsConfigured && !ownSession) {
    return status.acceptsRequestCredentials
      ? 'No LinkedIn session on the server. Open Settings to use your own.'
      : 'Server has no LinkedIn session configured — lookups will fail.';
  }

  const parts = [
    `v${status.version}`,
    ownSession ? 'your session' : `server session (${status.authMode})`,
    `${status.cache.size} cached`,
    `breaker ${status.breaker}`,
  ];
  if (roundTripMs !== null) parts.push(`${roundTripMs} ms round trip`);
  return parts.join(' · ');
}
