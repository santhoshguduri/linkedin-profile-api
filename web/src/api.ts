/**
 * Typed client for the profile API.
 *
 * The response types are imported from the server's zod schema as `import type`,
 * so they are erased at build time — no zod in the client bundle — while a change
 * to the response contract still breaks the UI build. The two halves cannot drift.
 */
import type {
  ContactInfo,
  DateRange,
  ImageAsset,
  Meta,
  Profile,
  ProfileResponse,
} from '../../server/src/schema/profile.js';

export type { ContactInfo, DateRange, ImageAsset, Meta, Profile, ProfileResponse };

/** Error codes the server can return, mirrored from src/util/errors.ts. */
export type ErrorCode =
  | 'INVALID_URL'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_CONFIGURED'
  | 'SESSION_INVALID'
  | 'CHALLENGE_REQUIRED'
  | 'CHALLENGE_PENDING'
  | 'CHALLENGE_EXPIRED'
  | 'LOGIN_FAILED'
  | 'LOGIN_UNAVAILABLE'
  | 'PROFILE_NOT_FOUND'
  | 'UPSTREAM_THROTTLED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

/**
 * Mirrored from the server rather than imported: the server's copy lives in
 * `linkedin/login.ts`, which type-imports Playwright, and dragging Playwright's
 * types into the browser build to share four string literals is a bad trade.
 */
export type ChallengeKind = 'app-approval' | 'code' | 'captcha' | 'unknown';

export interface ApiError {
  code: ErrorCode;
  message: string;
  hint?: string;
  retryAfterSeconds?: number;
  /** Carries the sign-in handle on CHALLENGE_PENDING. */
  details?: unknown;
}

export class ProfileApiError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly details: unknown;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ProfileApiError';
    this.code = error.code;
    this.hint = error.hint;
    this.retryAfterSeconds = error.retryAfterSeconds;
    this.details = error.details;
  }

  /**
   * The parked sign-in this error belongs to, when there is one. Narrowed here
   * rather than at the call site so the unknown-shaped `details` is only picked
   * apart in one place.
   */
  get challenge(): { handle?: string; challenge?: ChallengeKind } | undefined {
    return this.details && typeof this.details === 'object'
      ? (this.details as { handle?: string; challenge?: ChallengeKind })
      : undefined;
  }
}

export interface ServerStatus {
  status: string;
  version: string;
  cache: { size: number; hits: number; misses: number };
  inFlight: number;
  breaker: string;
  tokensAvailable: number;
  credentialsConfigured: boolean;
  authMode: 'cookie' | 'credentials' | 'none';
  /** True once the server actually holds a cookie, not merely the means to get one. */
  sessionReady: boolean;
  acceptsRequestCredentials: boolean;
  passwordLoginAvailable: boolean;
  activeSessions: number;
  activeLogins: number;
}

/**
 * The API is a separate deployment on a separate origin, so its base URL is
 * build-time configuration. Falling back to localhost keeps `npm run dev`
 * working with no .env file.
 */
export const API_BASE = (import.meta.env.VITE_API_URL ?? 'https://linkedin-profile-api-sx9g.vercel.app').replace(
  /\/+$/,
  '',
);

const KEY_STORAGE = 'linkedin-profile-api:key';
const SESSION_STORAGE = 'linkedin-profile-api:linkedin';

/**
 * An `x-api-key` for deployments that require one.
 *
 * Read-only, and no longer surfaced in the UI: this deployment does not gate the
 * API, and a key field on the settings dialog was one more thing to explain for
 * no benefit. Anyone fronting the API with a key can still set the storage entry
 * by hand and every request will carry it.
 */
export const apiKey = {
  get: (): string | null => localStorage.getItem(KEY_STORAGE),
};

/**
 * A LinkedIn session the visitor's lookups run as.
 *
 * Always a cookie by the time it is stored, whichever way it was obtained --
 * signing in with an email and password ends with the server harvesting exactly
 * this and handing it back, so the password is never held anywhere.
 */
export interface LinkedInSession {
  liAt?: string;
  jsessionId?: string;
  /**
   * A pasted `Cookie:` header or DevTools cookie table. The server pulls li_at
   * and JSESSIONID out of it and discards the rest, so someone who cannot install
   * the extension has a path that does not involve hunting for a single value.
   */
  cookie?: string;
  /**
   * The browser the cookie was minted under, returned by a sign-in and sent back
   * with each lookup so the server presents itself to LinkedIn as the client
   * that earned the session. Absent for a hand-pasted cookie, which cannot know.
   */
  userAgent?: string;
}

/**
 * Held in `sessionStorage`, not `localStorage`: it is cleared when the tab
 * closes, so a shared machine does not keep someone's LinkedIn password around
 * after they walk away.
 */
export const linkedInSession = {
  get(): LinkedInSession | null {
    const raw = sessionStorage.getItem(SESSION_STORAGE);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as LinkedInSession;
      return Object.values(parsed).some(Boolean) ? parsed : null;
    } catch {
      return null;
    }
  },
  set(value: LinkedInSession | null): void {
    const filled =
      value && Object.fromEntries(Object.entries(value).filter(([, v]) => v?.trim()));
    if (filled && Object.keys(filled).length > 0) {
      sessionStorage.setItem(SESSION_STORAGE, JSON.stringify(filled));
    } else {
      sessionStorage.removeItem(SESSION_STORAGE);
    }
  },
};

function authHeaders(): Record<string, string> {
  const key = apiKey.get();
  return key ? { 'x-api-key': key } : {};
}

/**
 * Success and failure share one envelope, so both are parsed the same way. A
 * body that is not JSON means the request died before reaching the app — a
 * proxy, a cold start, or a platform error page.
 */
async function parse<T>(res: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ProfileApiError({
      code: 'INTERNAL',
      message: `Server returned HTTP ${res.status} with a non-JSON body.`,
    });
  }

  if (!res.ok) {
    const error = (payload as { error?: ApiError }).error;
    throw new ProfileApiError(
      error ?? { code: 'INTERNAL', message: `Request failed with HTTP ${res.status}.` },
    );
  }
  return payload as T;
}

export async function fetchProfile(
  url: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<ProfileResponse> {
  const credentials = linkedInSession.get();
  const signal = options.signal ? { signal: options.signal } : {};

  // With a session attached the request becomes a POST, so the credentials
  // travel in a body rather than anywhere a proxy might log them.
  const res = credentials
    ? await fetch(`${API_BASE}/api/profile`, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ url, refresh: options.refresh ?? false, credentials }),
        ...signal,
      })
    : await fetch(
        `${API_BASE}/api/profile?${new URLSearchParams({
          url,
          ...(options.refresh ? { refresh: 'true' } : {}),
        }).toString()}`,
        { headers: authHeaders(), ...signal },
      );

  return parse<ProfileResponse>(res);
}

export async function fetchStatus(): Promise<ServerStatus> {
  return parse<ServerStatus>(await fetch(`${API_BASE}/api/status`));
}

/**
 * Signs in with an email and password.
 *
 * Resolves only when LinkedIn let the sign-in through. Anything that needs the
 * person -- a tap in the LinkedIn app, a verification code -- arrives as a
 * `ProfileApiError` with code `CHALLENGE_PENDING` and a handle on `.challenge`,
 * which `verifySignIn` then drives to completion.
 *
 * The password is sent once and is never stored, here or on the server: what
 * comes back is a cookie, and that is what every later lookup uses.
 */
export async function signIn(username: string, password: string): Promise<LinkedInSession> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await parse<{ credentials: LinkedInSession }>(res);
  return body.credentials;
}

/**
 * Takes a parked sign-in one step further.
 *
 * With no code this polls the approval push; the server holds the request open
 * for a few seconds before answering, so calling it in a loop costs one request
 * every several seconds rather than a busy wait. With a code it submits it.
 */
export async function verifySignIn(handle: string, code?: string): Promise<LinkedInSession> {
  const res = await fetch(`${API_BASE}/api/auth/verify`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ handle, ...(code ? { code } : {}) }),
  });
  const body = await parse<{ credentials: LinkedInSession }>(res);
  return body.credentials;
}

/** Releases the browser behind a sign-in the visitor walked away from. */
export async function cancelSignIn(handle: string): Promise<void> {
  await fetch(`${API_BASE}/api/auth/cancel`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  }).catch(() => {
    /* a browser that outlives its handle is reaped by the server anyway */
  });
}
