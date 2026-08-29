import type { ErrorCode } from '../api';
import { Badge } from './primitives';

/** Plain-language headline per error code. The server's message carries the detail. */
const TITLES: Record<ErrorCode, string> = {
  INVALID_URL: 'That is not a LinkedIn profile URL',
  BAD_REQUEST: 'The request was rejected',
  UNAUTHORIZED: 'API key required',
  NOT_CONFIGURED: 'The server has no LinkedIn session',
  SESSION_INVALID: 'The server session has expired',
  CHALLENGE_REQUIRED: 'LinkedIn asked for a security check',
  CHALLENGE_PENDING: 'LinkedIn is waiting for you to approve the sign-in',
  CHALLENGE_EXPIRED: 'That sign-in is no longer open',
  LOGIN_FAILED: 'LinkedIn rejected those credentials',
  LOGIN_UNAVAILABLE: 'This deployment cannot sign in with a password',
  PROFILE_NOT_FOUND: 'No such profile',
  UPSTREAM_THROTTLED: 'LinkedIn is rate limiting the server',
  RATE_LIMITED: 'Too many requests',
  TIMEOUT: 'LinkedIn took too long to respond',
  UPSTREAM_ERROR: 'LinkedIn returned an unexpected response',
  INTERNAL: 'Something went wrong',
};

export function ErrorPanel({
  code,
  message,
  hint,
  retryAfterSeconds,
  action,
}: {
  code: ErrorCode;
  message: string;
  hint?: string | undefined;
  retryAfterSeconds?: number | undefined;
  /** Offered when the failure is one the visitor can fix, such as a missing session. */
  action?: { label: string; onClick: () => void } | undefined;
}) {
  return (
    <section className="panel error" role="alert">
      <div className="error-head">
        <Badge tone="danger">{code}</Badge>
        <strong>{TITLES[code] ?? 'Request failed'}</strong>
      </div>
      <p>{message}</p>
      {hint && <p className="hint">{hint}</p>}
      {retryAfterSeconds != null && (
        <p className="hint">Retry in about {retryAfterSeconds} seconds.</p>
      )}
      {action && (
        <button type="button" className="primary error-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </section>
  );
}
