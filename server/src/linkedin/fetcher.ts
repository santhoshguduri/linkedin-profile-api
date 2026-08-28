/**
 * Outbound HTTP to LinkedIn.
 *
 * Everything defensive lives here: pacing, retries, cookie persistence, redirect
 * handling and the circuit breaker. Callers just ask for a URL and get back a
 * classified result.
 */
import { request, ProxyAgent, Agent, type Dispatcher } from 'undici';
import type { CookieJar } from 'tough-cookie';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { AppError } from '../util/errors.js';
import { TokenBucket, CircuitBreaker, backoffDelay, sleep } from '../util/ratelimit.js';
import type { ResolvedSession } from './credentials.js';
import {
  createCookieJar,
  hasSessionCookie,
  navigationHeaders,
  detectAuthState,
  DEFAULT_USER_AGENT,
  type AuthState,
} from './session.js';

export interface FetchResult {
  url: string;
  status: number;
  body: string;
  authState: AuthState;
}

const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
/** Opens after this many consecutive throttle/upstream failures. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
export class LinkedInFetcher {
  readonly #jar: CookieJar;
  readonly #bucket: TokenBucket;
  readonly #breaker: CircuitBreaker;
  readonly #dispatcher: Dispatcher;
  readonly #userAgent: string;
  /** Cached after the first check; the jar is seeded once and does not change. */
  #sessionChecked = false;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly session: ResolvedSession,
  ) {
    this.#jar = createCookieJar(session.credentials, config);
    this.#bucket = new TokenBucket(Math.max(2, config.OUTBOUND_RPM), config.OUTBOUND_RPM);
    this.#breaker = new CircuitBreaker(BREAKER_THRESHOLD, BREAKER_COOLDOWN_MS);
    this.#userAgent = process.env.USER_AGENT?.trim() || DEFAULT_USER_AGENT;
    this.#dispatcher = config.PROXY_URL
      ? new ProxyAgent({ uri: config.PROXY_URL, connectTimeout: config.REQUEST_TIMEOUT_MS })
      : new Agent({ connectTimeout: config.REQUEST_TIMEOUT_MS });
  }

  get breakerState() {
    return this.#breaker.state;
  }

  get tokensAvailable() {
    return this.#bucket.available;
  }

  /**
   * Guarantees the jar holds a session cookie before any request goes out, so a
   * missing credential fails as NOT_CONFIGURED instead of as an authwall three
   * requests later.
   */
  async #ensureSession(): Promise<void> {
    if (this.#sessionChecked) return;
    if (!(await hasSessionCookie(this.#jar))) {
      throw new AppError('NOT_CONFIGURED', 'No LinkedIn session is available for this request.');
    }
    this.#sessionChecked = true;
  }

  async close(): Promise<void> {
    await this.#dispatcher.close();
  }

  /** One hop. Redirects and retries are handled by the caller below. */
  async #hop(url: string, referer: string | undefined): Promise<{
    status: number;
    body: string;
    location: string | undefined;
  }> {
    const cookie = await this.#jar.getCookieString(url);
    const headers: Record<string, string> = {
      ...navigationHeaders(this.#userAgent),
      ...(cookie ? { cookie } : {}),
      ...(referer ? { referer } : {}),
    };

    const res = await request(url, {
      method: 'GET',
      headers,
      dispatcher: this.#dispatcher,
      // undici does not follow redirects unless a redirect interceptor is added,
      // which is exactly what we want: authwall bounces must be observed.
      headersTimeout: this.config.REQUEST_TIMEOUT_MS,
      bodyTimeout: this.config.REQUEST_TIMEOUT_MS,
    });

    // Persist rotating cookies (lidc, __cf_bm, bcookie). Without this, later
    // section fetches in the same run start failing.
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const raw of cookies) {
      try {
        await this.#jar.setCookie(raw, url);
      } catch {
        /* malformed cookie from upstream is not worth failing the request over */
      }
    }

    const location = res.headers.location;
    return {
      status: res.statusCode,
      body: await res.body.text(),
      location: Array.isArray(location) ? location[0] : location,
    };
  }

  /**
   * Fetches a LinkedIn page, following redirects manually so an authwall bounce
   * is observed rather than silently followed to a login form.
   */
  async fetchHtml(url: string, referer?: string): Promise<FetchResult> {
    await this.#ensureSession();

    if (this.#breaker.state === 'open') {
      throw new AppError(
        'UPSTREAM_THROTTLED',
        'Upstream circuit breaker is open after repeated throttling.',
        { retryAfterSeconds: this.#breaker.retryAfterSeconds },
      );
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt);
        this.log.warn({ url, attempt, delay }, 'retrying LinkedIn request');
        await sleep(delay);
      }

      await this.#bucket.take();

      try {
        let currentUrl = url;
        let hop = await this.#hop(currentUrl, referer);

        for (let r = 0; r < MAX_REDIRECTS && hop.status >= 300 && hop.status < 400; r++) {
          if (!hop.location) break;
          currentUrl = new URL(hop.location, currentUrl).toString();
          // A redirect to the login/authwall route is a definitive answer, not a hop to follow.
          if (/\/authwall|\/uas\/login|\/checkpoint\//i.test(currentUrl)) {
            this.#breaker.recordSuccess();
            return {
              url: currentUrl,
              status: hop.status,
              body: hop.body,
              authState: /checkpoint/i.test(currentUrl) ? 'challenge' : 'authwall',
            };
          }
          hop = await this.#hop(currentUrl, currentUrl);
        }

        const authState = detectAuthState(hop.status, hop.body);

        if (authState === 'throttled') {
          this.#breaker.recordFailure();
          lastError = new AppError('UPSTREAM_THROTTLED', `LinkedIn throttled the request (HTTP ${hop.status}).`, {
            retryAfterSeconds: this.#breaker.retryAfterSeconds || 60,
          });
          continue;
        }

        if (hop.status >= 500) {
          this.#breaker.recordFailure();
          lastError = new AppError('UPSTREAM_ERROR', `LinkedIn returned HTTP ${hop.status}.`);
          continue;
        }

        this.#breaker.recordSuccess();
        return { url: currentUrl, status: hop.status, body: hop.body, authState };
      } catch (error) {
        if (error instanceof AppError) throw error;
        lastError = error;
        this.log.warn({ err: error, url }, 'LinkedIn request failed');
      }
    }

    if (lastError instanceof AppError) throw lastError;
    throw new AppError('UPSTREAM_ERROR', 'LinkedIn request failed after retries.', {
      cause: lastError,
    });
  }

  /**
   * Fetches and asserts the response is a usable authenticated page, converting
   * every other outcome into a typed error.
   */
  async fetchAuthenticatedHtml(url: string, referer?: string): Promise<FetchResult> {
    // No retry on an authwall: a cookie cannot be re-derived, so a second attempt
    // would spend the outbound budget on the same failure.
    const result = await this.fetchHtml(url, referer);

    switch (result.authState) {
      case 'authenticated':
        return result;
      case 'authwall':
        throw new AppError('SESSION_INVALID', 'LinkedIn served the logged-out authwall.');
      case 'challenge':
        throw new AppError('CHALLENGE_REQUIRED', 'LinkedIn served a security checkpoint.');
      case 'not-found':
        throw new AppError('PROFILE_NOT_FOUND', 'LinkedIn returned 404 for this profile.');
      case 'throttled':
        throw new AppError('UPSTREAM_THROTTLED', 'LinkedIn is rate limiting this IP.');
      default:
        throw new AppError(
          'UPSTREAM_ERROR',
          `Unrecognised LinkedIn response (HTTP ${result.status}, ${result.body.length} bytes).`,
        );
    }
  }
}
