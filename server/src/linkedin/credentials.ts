/**
 * Which LinkedIn identity a lookup runs as.
 *
 * A deployment can carry one session in its environment, and a caller can also
 * supply their own on the request. Both paths are normalised here so nothing
 * downstream has to ask where a cookie came from.
 */
import { createHash } from 'node:crypto';

export interface SessionCredentials {
  liAt?: string | undefined;
  jsessionId?: string | undefined;
  /**
   * The User-Agent the cookie was minted under.
   *
   * LinkedIn ties a session to the client that created it, so replaying `li_at`
   * from a browser that looks nothing like the one that signed in is a signal
   * against you. Carrying the UA alongside the cookie -- rather than assuming a
   * single process-wide default -- means a harvested session is always replayed
   * as the browser that earned it. Optional: a pasted cookie may not know.
   */
  userAgent?: string | undefined;
}

/**
 * How a lookup got its session.
 *
 * `credentials` and `cookie` differ only in provenance -- a password sign-in
 * ends by harvesting `li_at` from a browser, so by the time a request is served
 * both modes are the same cookie. The distinction is kept because it is the
 * honest answer to "what did this deployment need from me", which /api/status
 * reports.
 */
export type AuthMode = 'cookie' | 'credentials' | 'none';

export interface ResolvedSession {
  readonly credentials: SessionCredentials;
  readonly mode: AuthMode;
  /**
   * Stable handle used to pool cookie jars and to partition the cache. It is a
   * truncated digest, never the material itself, so it is safe to log — and two
   * callers can only share a jar if they really are the same identity.
   */
  readonly key: string;
  /** True when the environment supplied it, false when the request did. */
  readonly fromEnvironment: boolean;
}

/** Shape of the environment fields this module reads. Structural on purpose: it
 *  keeps credentials.ts free of a dependency on config.ts. */
export interface CredentialEnv {
  LI_AT?: string | undefined;
  LI_JSESSIONID?: string | undefined;
}

const trim = (value: string | undefined): string | undefined => {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
};

/**
 * A User-Agent safe to put in an outbound header.
 *
 * This string can arrive from a request body, and it is written straight into a
 * header on the way to LinkedIn, so control characters would be a header
 * injection. Anything outside printable ASCII is dropped and the result is
 * capped -- a real UA is ~120 characters.
 */
const sanitiseUserAgent = (value: string | undefined): string | undefined => {
  const cleaned = value?.replace(/[^ -~]/g, '').trim().slice(0, 256);
  return cleaned ? cleaned : undefined;
};

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

/**
 * Normalises whatever cookie material arrived into one identity.
 *
 * Email and password never reach this function. A password is exchanged for a
 * cookie first, in `login.ts`, and only the cookie is passed on -- so there is
 * exactly one notion of identity downstream, and a pooled session cannot depend
 * on how it was obtained.
 */
export function resolveSession(
  input: SessionCredentials,
  fromEnvironment = false,
  mode: Exclude<AuthMode, 'none'> = 'cookie',
): ResolvedSession {
  const liAt = trim(input.liAt);
  // LinkedIn stores JSESSIONID quoted; both forms are accepted on input.
  const jsessionId = trim(input.jsessionId)?.replace(/^"|"$/g, '');
  const userAgent = sanitiseUserAgent(input.userAgent);

  if (!liAt) return { credentials: {}, mode: 'none', key: 'none', fromEnvironment };

  return {
    // The UA rides along with the cookie but stays out of the key: identity is
    // the cookie. Two callers holding the same session should share one jar even
    // if one of them reports a different browser.
    credentials: { liAt, jsessionId, userAgent },
    mode,
    key: `c_${digest(liAt)}`,
    fromEnvironment,
  };
}

export function sessionFromEnv(env: CredentialEnv): ResolvedSession {
  return resolveSession({ liAt: env.LI_AT, jsessionId: env.LI_JSESSIONID }, true);
}

/** True when any field was supplied, so an empty object is treated as "not given". */
export function hasAnyCredential(input: SessionCredentials | undefined): boolean {
  return Boolean(input && (input.liAt || input.jsessionId));
}

/**
 * Pulls a session out of a pasted cookie blob.
 *
 * `li_at` is HttpOnly, so a page script cannot read it and a bookmarklet cannot
 * capture it. Without the browser extension there are only two things a person
 * can realistically get at: the value shown in DevTools > Application > Cookies,
 * or the whole `Cookie:` request header copied from the Network tab. This accepts
 * either, plus the bare cookie value on its own, so nobody has to be told which
 * of the three they pasted.
 *
 * Everything other than li_at and JSESSIONID is discarded rather than forwarded:
 * a copied header also carries analytics and fingerprinting cookies that we have
 * no reason to hold.
 */
export function parseCookieHeader(raw: string | undefined): SessionCredentials {
  const text = trim(raw);
  if (!text) return {};

  // A bare li_at with no name attached. The prefix is stable across LinkedIn's
  // token versions and no other cookie in the set starts with it.
  if (!text.includes('=') && /^AQ[A-Za-z0-9_-]{20,}$/.test(text)) {
    return { liAt: text };
  }

  const found = new Map<string, string>();
  // Split on ";" or newlines so a copied header and a copied DevTools table both
  // work; the value itself is never split, since cookie values cannot contain ";".
  for (const part of text.split(/[;\n\r]+/)) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (value) found.set(name, value);
  }

  return { liAt: found.get('li_at'), jsessionId: found.get('jsessionid') };
}

/**
 * Merges the explicit fields with anything parsed out of a pasted blob. The
 * explicit fields win, so a caller that sends both is not surprised.
 */
export function mergeCredentials(
  explicit: SessionCredentials,
  pasted: SessionCredentials,
): SessionCredentials {
  return {
    liAt: trim(explicit.liAt) ?? pasted.liAt,
    jsessionId: trim(explicit.jsessionId) ?? pasted.jsessionId,
  };
}
