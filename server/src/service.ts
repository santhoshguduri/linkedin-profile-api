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
import { TtlCache } from './util/cache.js';
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
  readonly #envSession: ResolvedSession;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.#envSession = sessionFromEnv(config);
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
      credentialsConfigured: this.#envSession.mode !== 'none',
      authMode: this.#envSession.mode,
      acceptsRequestCredentials: this.config.ALLOW_REQUEST_CREDENTIALS,
      activeSessions: this.#pool.size,
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#pool.values()].map((entry) => entry.fetcher.close()));
    this.#pool.clear();
  }

  async getProfile(input: string, opts: LookupOptions = {}): Promise<ProfileResponse> {
    const { publicIdentifier: slug } = parseProfileUrl(input);
    const session = opts.credentials
      ? resolveSession(opts.credentials)
      : this.#envSession;

    if (session.mode === 'none') {
      throw new AppError('NOT_CONFIGURED', 'No LinkedIn session is available for this request.', {
        hint: this.config.ALLOW_REQUEST_CREDENTIALS
          ? 'Send your own session with the request: { "credentials": { "liAt": "<your li_at cookie>" } }.'
          : 'This deployment does not accept a session on the request. Configure LI_AT on the server.',
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
    const result = await extractProfile(slug, fetcher, this.config, this.log);

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
