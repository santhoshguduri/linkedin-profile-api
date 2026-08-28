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
  | 'LOGIN_UNSUPPORTED'
  | 'PROFILE_NOT_FOUND'
  | 'UPSTREAM_THROTTLED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export interface ApiError {
  code: ErrorCode;
  message: string;
  hint?: string;
  retryAfterSeconds?: number;
}

export class ProfileApiError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ProfileApiError';
    this.code = error.code;
    this.hint = error.hint;
    this.retryAfterSeconds = error.retryAfterSeconds;
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
  authMode: 'cookie' | 'none';
  acceptsRequestCredentials: boolean;
  activeSessions: number;
}

/**
 * The API is a separate deployment on a separate origin, so its base URL is
 * build-time configuration. Falling back to localhost keeps `npm run dev`
 * working with no .env file.
 */
export const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);

const KEY_STORAGE = 'linkedin-profile-api:key';
const SESSION_STORAGE = 'linkedin-profile-api:linkedin';

export const apiKey = {
  get: (): string | null => localStorage.getItem(KEY_STORAGE),
  set: (value: string): void => {
    if (value.trim()) localStorage.setItem(KEY_STORAGE, value.trim());
    else localStorage.removeItem(KEY_STORAGE);
  },
};

/**
 * A LinkedIn session the visitor supplies for their own lookups. Cookie only:
 * LinkedIn retired form-based sign-in, so the API rejects an email and password
 * with LOGIN_UNSUPPORTED.
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
