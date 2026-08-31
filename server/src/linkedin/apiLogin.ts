/**
 * Signing in without driving a browser.
 *
 * The sign-in form at /uas/login is behind PerimeterX, which fingerprints the
 * client and answers anything automation-shaped with a CAPTCHA. That is a wall,
 * not a puzzle: a CAPTCHA cannot be cleared unattended, so every headless
 * password login ends the same way no matter how carefully the browser is
 * disguised. Stealth flags treat the symptom.
 *
 * /uas/authenticate is the endpoint the LinkedIn mobile app posts to. It is
 * form-encoded HTTP that predates the SPA, it runs no client-side fingerprinting
 * because a native app has no DOM to fingerprint, and it answers with a verdict
 * rather than a challenge page. That is the whole reason this file exists.
 *
 * It is not a way around verification. When LinkedIn wants a human it still says
 * so, as login_result CHALLENGE plus a URL, and that URL is handed to a real
 * browser by the caller. What changes is that the browser now opens on the
 * approval screen instead of on the form that was refusing to let it through.
 */
import { request, Agent, ProxyAgent, type Dispatcher } from 'undici';
import { AppError } from '../util/errors.js';
import type { SessionCredentials } from './credentials.js';
import { CHALLENGE_MESSAGES, type ChallengeKind, type LoginOutcome } from './login.js';

const ORIGIN = 'https://www.linkedin.com';
const AUTH_URL = ORIGIN + '/uas/authenticate';

/**
 * The client this pretends to be, and it has to be consistent.
 *
 * X-Li-User-Agent is what LinkedIn reads to decide which client is calling; the
 * plain User-Agent is the app's, which is terse in a way no browser ever is.
 * Sending a desktop Chrome string here would be a mobile client claiming to be a
 * browser, which is a worse story than either one alone.
 */
const APP_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'ANDROID OS',
  'X-Li-User-Agent': 'LIAuthLibrary:0.0.3 com.linkedin.android:4.1.881 Asus_ASUS_Z01QD:26',
  'X-User-Language': 'en',
  'X-User-Locale': 'en_US',
  'Accept-Language': 'en-us',
};

/** Cookies the seed request hands us, kept as a plain name-to-value map. */
type Jar = Map<string, string>;

/**
 * Reads Set-Cookie without a cookie library.
 *
 * Only the name and value matter here. Domain, path and expiry are LinkedIn
 * talking to a browser about storage, and there is no storage in this flow --
 * the jar lives for two requests and is then either discarded or reduced to the
 * one cookie worth keeping.
 */
type RawHeaders = Record<string, string | string[] | undefined>;

function collect(headers: RawHeaders, into: Jar): Jar {
  const raw = headers['set-cookie'];
  for (const line of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const pair = line.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    into.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return into;
}

const serialise = (jar: Jar): string =>
  [...jar].map(([name, value]) => name + '=' + value).join('; ');

/**
 * What LinkedIn says when a password is refused, in words a caller can act on.
 *
 * Anything not listed is reported with its raw code attached rather than being
 * flattened into "sign-in failed". These codes are LinkedIn's to change, and one
 * in the message is the difference between a five-minute fix and an afternoon of
 * guessing.
 */
const RESULT_MESSAGES: Readonly<Record<string, string>> = {
  BAD_PASSWORD: 'That password is not right for this account.',
  BAD_EMAIL: 'LinkedIn has no account with that email address.',
  ACCOUNT_LOCKED:
    'LinkedIn has locked this account. Sign in from your own browser to unlock it, then try again.',
  PASSWORD_RESET_REQUESTED:
    'LinkedIn wants this password reset before it will allow a sign-in.',
  PASSWORD_RESET_RECOMMENDED:
    'LinkedIn wants this password reset before it will allow a sign-in.',
};

/**
 * A challenge the caller has to finish somewhere else.
 *
 * The cookies travel with it because the checkpoint is bound to the session that
 * created it. Opening the URL in a fresh browser restarts the sign-in and lands
 * back on the form; opening it with these cookies resumes the exact verification
 * LinkedIn just asked for.
 */
export interface ApiChallenge {
  readonly status: 'challenge';
  readonly kind: ChallengeKind;
  readonly message: string;
  readonly url: string;
  readonly cookies: ReadonlyMap<string, string>;
}

export type ApiLoginResult =
  | { status: 'authenticated'; credentials: SessionCredentials }
  | ApiChallenge
  | { status: 'failed'; message: string };

export interface ApiLoginOptions {
  readonly timeoutMs: number;
  readonly proxyUrl?: string | undefined;
}

const dispatcherFor = (options: ApiLoginOptions): Dispatcher =>
  options.proxyUrl
    ? new ProxyAgent({ uri: options.proxyUrl, connectTimeout: options.timeoutMs })
    : new Agent({ connectTimeout: options.timeoutMs });

/**
 * A CHALLENGE here is nearly always the phone approval, so that is the default
 * rather than "unknown".
 *
 * The URL is the only hint available, since there is no page text to read and
 * page text is what classifyChallenge works from. Treating an unrecognised
 * checkpoint as app-approval keeps it waitable, which is the bias the login
 * manager already argues for: a screen this code cannot name is usually an
 * approval prompt worded in a way it has not seen, and failing fast on one
 * strands somebody who is still reaching for their phone.
 */
export function classifyByUrl(url: string): ChallengeKind {
  const lower = url.toLowerCase();
  if (lower.includes('captcha')) return 'captcha';
  if (lower.includes('two-step') || lower.includes('pin') || lower.includes('otp')) return 'code';
  return 'app-approval';
}

export interface AuthBody {
  readonly login_result?: unknown;
  readonly challenge_url?: unknown;
}

/**
 * The endpoint answers JSON, but not always: a host LinkedIn has decided to
 * block gets an HTML block page, sometimes with a 200 on it. Parsing that as
 * JSON throws a syntax error, which is a confusing thing to show somebody who
 * just typed a password, so it is named here instead.
 */
function readResult(text: string, status: number): AuthBody {
  try {
    return JSON.parse(text) as AuthBody;
  } catch {
    throw new AppError(
      'CHALLENGE_REQUIRED',
      'LinkedIn refused the sign-in without answering it, which usually means it does not trust this server.',
      {
        hint: 'Connect with the browser extension instead, or route the server through PROXY_URL.',
        details: { status },
      },
    );
  }
}

/**
 * Turns one JSON body plus the cookies it arrived with into a result.
 *
 * Exported because it is the part most likely to need adjusting when
 * LinkedIn adds a result code, and the only part that can be tested without
 * a live account -- the same reason classifyChallenge is exported next door.
 */
export function interpretAuthResponse(body: AuthBody, jar: ReadonlyMap<string, string>): ApiLoginResult {
  const result = typeof body.login_result === 'string' ? body.login_result : 'UNKNOWN';

  if (result === 'PASS') {
    const liAt = jar.get('li_at');
    if (!liAt) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'LinkedIn accepted the password but issued no session cookie.',
      );
    }
    const jsessionId = jar.get('JSESSIONID');
    return {
      status: 'authenticated',
      credentials: {
        liAt,
        ...(jsessionId ? { jsessionId } : {}),
        // The client the cookie was minted under, so every later request
        // replays it as the one LinkedIn issued it to.
        userAgent: APP_HEADERS['User-Agent'],
      },
    };
  }

  if (result === 'CHALLENGE') {
    const raw = typeof body.challenge_url === 'string' ? body.challenge_url : '';
    if (!raw) {
      return {
        status: 'failed',
        message: 'LinkedIn wants an extra verification step but did not say which one.',
      };
    }
    const kind = classifyByUrl(raw);
    return {
      status: 'challenge',
      kind,
      message: CHALLENGE_MESSAGES[kind],
      url: raw.startsWith('http') ? raw : ORIGIN + raw,
      cookies: jar,
    };
  }

  return {
    status: 'failed',
    message: RESULT_MESSAGES[result] ?? 'LinkedIn refused the sign-in (' + result + ').',
  };
}

/** Reduces an API result to the outcome shape the rest of the login code speaks. */
export const toOutcome = (result: ApiLoginResult): LoginOutcome =>
  result.status === 'challenge'
    ? { status: 'challenge', kind: result.kind, message: result.message }
    : result;

/**
 * Signs in with an email and password.
 *
 * Two requests: one to be issued a JSESSIONID, and one to spend it. LinkedIn
 * wants that token in the body as well as in the cookie header, the same string
 * in both places, which is its CSRF check. Omitting the body copy fails the
 * sign-in with a result code that says nothing about why.
 */
export async function apiSignIn(
  username: string,
  password: string,
  options: ApiLoginOptions,
): Promise<ApiLoginResult> {
  const dispatcher = dispatcherFor(options);
  const jar: Jar = new Map();
  const common = { dispatcher, headersTimeout: options.timeoutMs, bodyTimeout: options.timeoutMs };

  try {
    const seed = await request(AUTH_URL, { method: 'GET', headers: APP_HEADERS, ...common });
    collect(seed.headers as RawHeaders, jar);
    // Nothing in the seed body is useful, but undici holds the connection open
    // until it is read, and an unread body leaks a socket per sign-in.
    await seed.body.dump();

    const csrf = jar.get('JSESSIONID');
    if (!csrf) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'LinkedIn did not issue a sign-in token, so the password was never submitted.',
        { hint: 'Usually transient. If it persists, LinkedIn may be blocking this host.' },
      );
    }

    const response = await request(AUTH_URL, {
      method: 'POST',
      headers: {
        ...APP_HEADERS,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: serialise(jar),
      },
      // The token is quoted exactly as the cookie carries it. LinkedIn compares
      // the two strings literally, so trimming the quotes fails the CSRF check.
      body: new URLSearchParams({
        session_key: username,
        session_password: password,
        JSESSIONID: csrf,
      }).toString(),
      ...common,
    });
    collect(response.headers as RawHeaders, jar);

    return interpretAuthResponse(readResult(await response.body.text(), response.statusCode), jar);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const name = error instanceof Error ? error.name : '';
    if (name.includes('Timeout') || name === 'AbortError') {
      throw new AppError('TIMEOUT', 'LinkedIn did not answer the sign-in in time.', {
        cause: error,
      });
    }
    throw new AppError('UPSTREAM_ERROR', 'Could not reach LinkedIn to sign in.', { cause: error });
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
