/**
 * Application service: owns the session pool, the cache and the in-flight map.
 * Routes call this and nothing else.
 */
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { LinkedInFetcher } from './linkedin/fetcher.js';
import {
  resolveSession,
  sessionFromEnv,
  type ResolvedSession,
  type SessionCredentials,
} from './linkedin/credentials.js';
import { extractProfile } from './linkedin/extract/index.js';
import { parseProfileUrl } from './linkedin/url.js';
import { LoginManager, EnvironmentLogin } from './linkedin/loginManager.js';
import { TtlCache } from './util/cache.js';
import { chromiumKnown } from './linkedin/renderer.js';
import { AppError } from './util/errors.js';
import { ProfileResponseSchema, type ProfileResponse } from './schema/profile.js';

/** A caller-supplied session is dropped once it has gone this long unused. */
const SESSION_IDLE_MS = 15 * 60_000;
/** Ceiling on concurrently pooled identities; the least recently used is evicted. */
const MAX_SESSIONS = 12;

interface PooledSession {
  readonly fetcher: LinkedInFetcher;
  lastUsed: number;
}

export interface LookupOptions {
  refresh?: boolean;
  /** Overrides the deployment session for this request only. Never persisted. */
  credentials?: SessionCredentials | undefined;
}

export class ProfileService {
  readonly #cache: TtlCache<ProfileResponse>;
  /**
   * Coalesces concurrent requests for the same profile. Without this, a page
   * refresh or double-click doubles the outbound request count — the fastest way
   * to earn an HTTP 999.
   */
  readonly #inFlight = new Map<string, Promise<ProfileResponse>>();
  /**
   * One cookie jar, token bucket and circuit breaker per identity. Sharing them
   * across identities would let one caller's throttling stall everyone else, and
   * would leak cookies between accounts.
   */
  readonly #pool = new Map<string, PooledSession>();
  /**
   * The deployment's own identity. Not readonly: with LI_AT unset and
   * LI_USERNAME/LI_PASSWORD set, it starts as "none" and is replaced by the
   * cookie harvested from the first browser sign-in.
   */
  #envSession: ResolvedSession;
  readonly #logins: LoginManager;
  /** Absent unless this deployment was given an account to sign in with. */
  readonly #envLogin: EnvironmentLogin | undefined;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.#envSession = sessionFromEnv(config);
    this.#logins = new LoginManager(
      {
        enabled: config.BROWSER_LOGIN,
        headless: config.BROWSER_HEADLESS,
        navigationTimeoutMs: config.REQUEST_TIMEOUT_MS,
        waitMs: config.LOGIN_WAIT_MS,
        proxyUrl: config.PROXY_URL,
        debugDir: config.LOGIN_DEBUG_DIR,
      },
      log,
    );
    this.#envLogin =
      config.BROWSER_LOGIN && config.LI_USERNAME && config.LI_PASSWORD
        ? new EnvironmentLogin(this.#logins, config.LI_USERNAME, config.LI_PASSWORD, log)
        : undefined;
    this.#cache = new TtlCache<ProfileResponse>(
      config.CACHE_TTL_SECONDS * 1000,
      config.CACHE_MAX_ENTRIES,
    );
  }

  get stats() {
    const env = this.#pool.get(this.#envSession.key)?.fetcher;
    return {
      cache: this.#cache.stats(),
      inFlight: this.#inFlight.size,
      breaker: env?.breakerState ?? 'closed',
      tokensAvailable: Math.floor(env?.tokensAvailable ?? this.config.OUTBOUND_RPM),
      credentialsConfigured: this.config.hasCredentials,
      authMode: this.config.authMode,
      /** True once a cookie is actually in hand, as opposed to merely obtainable. */
      sessionReady: this.#envSession.mode !== 'none',
      acceptsRequestCredentials: this.config.ALLOW_REQUEST_CREDENTIALS,
      /** Permission and capability both, so the client never offers a 501. */
      passwordLoginAvailable: this.config.BROWSER_LOGIN && chromiumKnown() !== false,
      activeSessions: this.#pool.size,
      activeLogins: this.#logins.activeLogins,
    };
  }

  /** The sign-in registry, for the auth routes. */
  get logins(): LoginManager {
    return this.#logins;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#pool.values()].map((entry) => entry.fetcher.close()));
    this.#pool.clear();
    await this.#logins.close();
  }

  async getProfile(input: string, opts: LookupOptions = {}): Promise<ProfileResponse> {
    const { publicIdentifier: slug } = parseProfileUrl(input);
    const session = opts.credentials
      ? resolveSession(opts.credentials)
      : await this.#environmentSession();

    if (session.mode === 'none') {
      throw new AppError('NOT_CONFIGURED', 'No LinkedIn session is available for this request.', {
        hint: this.config.ALLOW_REQUEST_CREDENTIALS
          ? 'Sign in at POST /api/auth/login, or send a cookie: { "credentials": { "liAt": "<your li_at>" } }.'
          : 'This deployment does not accept a session on the request. Configure LI_AT or LI_USERNAME/LI_PASSWORD on the server.',
      });
    }

    /**
     * The cache is partitioned by identity. LinkedIn shows different fields to
     * different viewers, so serving one caller's copy to another would be both
     * wrong and a privacy leak.
     */
    const cacheKey = `${session.key}:${slug}`;

    if (!opts.refresh) {
      const hit = this.#cache.get(cacheKey);
      if (hit) {
        this.log.debug({ slug }, 'cache hit');
        return { ...hit, meta: { ...hit.meta, cached: true, strategy: 'cache' } };
      }
    }

    const existing = this.#inFlight.get(cacheKey);
    if (existing) {
      this.log.debug({ slug }, 'joined in-flight request');
      return existing;
    }

    const work = this.#extract(slug, session, cacheKey).finally(() =>
      this.#inFlight.delete(cacheKey),
    );
    this.#inFlight.set(cacheKey, work);
    return work;
  }

  async #extract(
    slug: string,
    session: ResolvedSession,
    cacheKey: string,
  ): Promise<ProfileResponse> {
    const started = Date.now();
    const fetcher = this.#fetcherFor(session);

    let result;
    try {
      result = await extractProfile(slug, fetcher, this.config, this.log);
    } catch (error) {
      if (error instanceof AppError && error.code === 'SESSION_INVALID') {
        this.#invalidateEnvironmentSession(session.key);
      }
      throw error;
    }

    const response = ProfileResponseSchema.parse({
      profile: result.profile,
      meta: {
        strategy: 'html',
        sources: result.sources,
        missingSections: result.missingSections,
        partial: result.missingSections.length > 0 || result.warnings.length > 0,
        cached: false,
        fetchedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        warnings: result.warnings,
      },
    });

    this.#cache.set(cacheKey, response);
    this.log.info(
      {
        slug,
        session: session.key,
        durationMs: response.meta.durationMs,
        missing: result.missingSections.length,
      },
      'profile extracted',
    );
    return response;
  }

  /**
   * The deployment's own session, signing in first if that is what it takes.
   *
   * A cookie in LI_AT short-circuits this entirely. Only when there is no cookie
   * and there are credentials does a browser get launched, and only once -- the
   * harvested cookie is promoted to *be* the environment session, so the second
   * request costs nothing and the account owner's phone stays quiet.
   */
  async #environmentSession(): Promise<ResolvedSession> {
    if (this.#envSession.mode !== 'none') return this.#envSession;
    if (!this.#envLogin) return this.#envSession;

    const credentials = await this.#envLogin.credentials();
    this.#envSession = resolveSession(credentials, true, 'credentials');
    this.log.info({ session: this.#envSession.key }, 'environment session established by sign-in');
    return this.#envSession;
  }

  /**
   * Drops a harvested session that LinkedIn has since rejected, so the next
   * request signs in again instead of retrying a dead cookie forever. A cookie
   * that came from LI_AT is left alone: re-signing-in cannot fix an env var.
   */
  #invalidateEnvironmentSession(key: string): void {
    if (!this.#envLogin || this.#envSession.key !== key) return;
    this.#pool.delete(key);
    this.#envSession = { credentials: {}, mode: 'none', key: 'none', fromEnvironment: true };
    this.log.warn('harvested session rejected by LinkedIn; will sign in again');
  }

  /** Returns the pooled fetcher for an identity, creating it on first use. */
  #fetcherFor(session: ResolvedSession): LinkedInFetcher {
    this.#reap();

    const existing = this.#pool.get(session.key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.fetcher;
    }

    const fetcher = new LinkedInFetcher(this.config, this.log, session);
    this.#pool.set(session.key, { fetcher, lastUsed: Date.now() });
    this.log.debug({ session: session.key, mode: session.mode }, 'session pooled');
    return fetcher;
  }

  /**
   * Drops idle sessions, then the oldest if the pool is still over its ceiling.
   * The environment session is exempt: it is the deployment's own identity and
   * re-creating it would throw away a warm cookie jar for nothing.
   */
  #reap(): void {
    const now = Date.now();
    const drop = (key: string, entry: PooledSession) => {
      this.#pool.delete(key);
      void entry.fetcher.close().catch(() => {
        /* a dispatcher that fails to close is not worth failing a lookup over */
      });
      this.log.debug({ session: key }, 'session evicted');
    };

    for (const [key, entry] of this.#pool) {
      if (key === this.#envSession.key) continue;
      if (now - entry.lastUsed > SESSION_IDLE_MS) drop(key, entry);
    }

    while (this.#pool.size > MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, entry] of this.#pool) {
        if (key === this.#envSession.key) continue;
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      drop(oldestKey, this.#pool.get(oldestKey)!);
    }
  }
}
