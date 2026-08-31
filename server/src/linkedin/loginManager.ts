/**
 * Owns every in-progress sign-in.
 *
 * A password sign-in that hits LinkedIn's app-approval challenge cannot finish
 * inside one HTTP request: it finishes when somebody picks up their phone. So
 * the browser is parked here under an opaque handle, and the caller comes back
 * to it. That is the whole reason this file exists -- without the challenge step
 * a login would just be a function call.
 *
 * Nothing here is persisted. A restart drops every pending sign-in, which is the
 * correct trade: a half-completed authentication is not something worth writing
 * to disk.
 */
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '../util/errors.js';
import type { SessionCredentials } from './credentials.js';
import { apiSignIn, toOutcome } from './apiLogin.js';
import { BrowserLogin, type ChallengeKind, type LoginOutcome } from './login.js';

/** A parked sign-in is abandoned after this long. Chromium is too expensive to leak. */
const PENDING_TTL_MS = 5 * 60_000;

/**
 * Challenges that are resolved by waiting rather than by typing.
 *
 * `unknown` is in here deliberately. It means LinkedIn showed a screen this API
 * could not name -- which is not the same as a screen nobody can clear, and in
 * practice is usually an approval prompt worded in a way the classifier has not
 * seen. Treating it as terminal closed the browser and failed the sign-in within
 * seconds, while the person was still reaching for their phone. Waiting on it
 * costs one parked browser and is right far more often than it is wrong.
 */
const WAITABLE: ReadonlySet<ChallengeKind> = new Set(['app-approval', 'unknown']);

/** Exported for the tests: the rule above is the one that decides fail-vs-wait. */
export const isWaitableChallenge = (kind: ChallengeKind): boolean => WAITABLE.has(kind);
/** Ceiling on concurrent browsers. Each one costs roughly 100 MB of RSS. */
const MAX_PENDING = 4;

interface Pending {
  readonly handle: string;
  readonly login: BrowserLogin;
  kind: ChallengeKind;
  touched: number;
}

/** What a caller gets back: an outcome, plus a handle when there is more to do. */
export type LoginProgress = LoginOutcome & { handle?: string };

export interface LoginManagerOptions {
  headless: boolean;
  navigationTimeoutMs: number;
  /** How long a single poll may block before answering "still waiting". */
  waitMs: number;
  proxyUrl?: string | undefined;
  debugDir?: string | undefined;
  /** Whether Chromium may be launched: for the form, or to finish a challenge. */
  enabled: boolean;
  /** Whether the mobile-app auth endpoint may be used before the form. */
  apiLogin: boolean;
}

export class LoginManager {
  readonly #pending = new Map<string, Pending>();

  constructor(
    private readonly options: LoginManagerOptions,
    private readonly log: Logger,
  ) {}

  get activeLogins(): number {
    return this.#pending.size;
  }

  /**
   * Runs a sign-in from scratch.
   *
   * On success the browser is closed immediately -- the cookie is the only thing
   * worth keeping, and a browser held open is a browser leaking memory. It stays
   * open only when LinkedIn asked for something a person has to do.
   */
  async start(username: string, password: string): Promise<LoginProgress> {
    if (!this.options.apiLogin && !this.options.enabled) {
      throw new AppError(
        'LOGIN_UNAVAILABLE',
        'Password sign-in is switched off on this deployment.',
        { hint: 'Send a li_at cookie instead, or set API_LOGIN=true on the server.' },
      );
    }

    this.#reap();

    if (this.options.apiLogin) {
      try {
        return await this.#startViaApi(username, password);
      } catch (error) {
        // The form is a poor substitute -- it is the path that gets CAPTCHAs --
        // but "LinkedIn would not talk to this host" is exactly the case where
        // a different client shape occasionally gets through, and refusing to
        // try costs the caller a sign-in they might have had.
        if (!this.options.enabled) throw error;
        this.log.warn({ err: error }, 'api sign-in unavailable, falling back to the login form');
      }
    }

    return this.#startViaBrowser(username, password);
  }

  /**
   * Signs in over HTTP, and only reaches for a browser if LinkedIn asks for one.
   *
   * The happy path here never launches Chromium at all, which is worth saying
   * out loud: it is the difference between a sign-in costing a few kilobytes and
   * costing 300 MB on an instance that is already tight for rendering.
   */
  async #startViaApi(username: string, password: string): Promise<LoginProgress> {
    const result = await apiSignIn(username, password, {
      timeoutMs: this.options.navigationTimeoutMs,
      proxyUrl: this.options.proxyUrl,
    });

    // LinkedIn's own verdict, logged before anything is done with it. Every
    // later branch is a consequence of this one string, and without it a
    // sign-in that ends in "unknown" cannot be told apart from one that never
    // reached LinkedIn at all.
    this.log.info(
      { result: result.code, next: result.status },
      'linkedin answered the password sign-in',
    );

    if (result.status !== 'challenge') {
      if (result.status === 'authenticated') this.log.info('password sign-in succeeded');
      return toOutcome(result);
    }

    // Nothing here can be finished without a rendered page, so a deployment
    // with no browser reports the challenge and stops rather than parking a
    // handle that could never be resumed.
    if (!this.options.enabled) return toOutcome(result);

    this.#assertCapacity();
    const login = await BrowserLogin.openAt(this.#browserOptions(), result.url, result.cookies);

    let outcome: LoginOutcome;
    try {
      outcome = await login.state();
      if (outcome.status === 'challenge' && WAITABLE.has(outcome.kind)) {
        outcome = await login.waitForApproval(this.options.waitMs);
      }
    } catch (error) {
      await login.close();
      throw error;
    }

    return this.#settle(login, outcome);
  }

  /** The original path: drive the sign-in form in Chromium. */
  async #startViaBrowser(username: string, password: string): Promise<LoginProgress> {
    this.#assertCapacity();
    const login = await BrowserLogin.open(this.#browserOptions());

    let outcome: LoginOutcome;
    try {
      outcome = await login.signIn(username, password);
      // An approval push often lands while the request is still open, so the
      // first wait is spent here rather than making the caller poll for it.
      if (outcome.status === 'challenge' && WAITABLE.has(outcome.kind)) {
        outcome = await login.waitForApproval(this.options.waitMs);
      }
    } catch (error) {
      await login.close();
      throw error;
    }

    return this.#settle(login, outcome);
  }

  #browserOptions() {
    return {
      headless: this.options.headless,
      navigationTimeoutMs: this.options.navigationTimeoutMs,
      proxyUrl: this.options.proxyUrl,
      debugDir: this.options.debugDir,
    };
  }

  #assertCapacity(): void {
    if (this.#pending.size >= MAX_PENDING) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many sign-ins are waiting for verification. Try again shortly.',
        { retryAfterSeconds: 60 },
      );
    }
  }

  /**
   * Picks a parked sign-in back up: polls an approval, or answers a code.
   * The handle is consumed on any terminal outcome, so a stale one cannot be
   * replayed.
   */
  async resume(handle: string, code?: string): Promise<LoginProgress> {
    this.#reap();
    const entry = this.#pending.get(handle);
    if (!entry) {
      throw new AppError(
        'CHALLENGE_EXPIRED',
        'That sign-in is no longer open. Start again.',
        { hint: 'Verification requests expire after five minutes, and after a server restart.' },
      );
    }

    entry.touched = Date.now();

    let outcome: LoginOutcome;
    try {
      outcome = code?.trim()
        ? await entry.login.submitCode(code)
        : await entry.login.waitForApproval(this.options.waitMs);
    } catch (error) {
      this.#pending.delete(handle);
      await entry.login.close();
      throw error;
    }

    this.#pending.delete(handle);
    return this.#settle(entry.login, outcome, handle);
  }

  /** Abandons a parked sign-in and frees its browser. Idempotent. */
  async cancel(handle: string): Promise<boolean> {
    const entry = this.#pending.get(handle);
    if (!entry) return false;
    this.#pending.delete(handle);
    await entry.login.close();
    this.log.debug({ handle }, 'sign-in cancelled');
    return true;
  }

  async close(): Promise<void> {
    const open = [...this.#pending.values()];
    this.#pending.clear();
    await Promise.allSettled(open.map((entry) => entry.login.close()));
  }

  /**
   * Decides whether a browser is still worth holding.
   *
   * Everything a person can clear from where they are standing is resumable: an
   * approval they can tap, a code they can type, and an unrecognised screen that
   * may well be either. A CAPTCHA is the one exception -- it cannot be answered
   * through this API at all, so parking that browser would hold 100 MB open for
   * a handle nobody can ever use.
   */
  async #settle(
    login: BrowserLogin,
    outcome: LoginOutcome,
    reuseHandle?: string,
  ): Promise<LoginProgress> {
    const resumable =
      outcome.status === 'challenge' && (WAITABLE.has(outcome.kind) || outcome.kind === 'code');

    if (!resumable) {
      await login.close();
      if (outcome.status === 'authenticated') this.log.info('password sign-in succeeded');
      return outcome;
    }

    // An unrecognised screen is parked and waited on, which is the right call --
    // but it is also the one outcome nobody can debug from the response alone,
    // so what LinkedIn actually put on screen goes to the log once.
    if (outcome.status === 'challenge' && outcome.kind === 'unknown') {
      try {
        this.log.warn(await login.describeScreen(), 'unrecognised verification screen');
      } catch (err) {
        // Swallowing this was a mistake: a failure to read the screen and a
        // screen with nothing on it are different problems, and the silent
        // version looked exactly like the log line never running.
        this.log.warn({ err }, 'unrecognised verification screen, and it could not be read');
      }
    }

    const handle = reuseHandle ?? randomBytes(18).toString('base64url');
    this.#pending.set(handle, { handle, login, kind: outcome.kind, touched: Date.now() });
    this.log.info({ handle, challenge: outcome.kind }, 'sign-in waiting on verification');
    return { ...outcome, handle };
  }

  /** Closes anything nobody came back for. */
  #reap(): void {
    const now = Date.now();
    for (const [handle, entry] of this.#pending) {
      if (now - entry.touched <= PENDING_TTL_MS) continue;
      this.#pending.delete(handle);
      void entry.login.close();
      this.log.debug({ handle }, 'sign-in expired');
    }
  }
}

/**
 * Signs in with the deployment's own credentials, at most once at a time.
 *
 * Coalescing matters here in a way it does not for a caller-driven login: a cold
 * start that takes ten concurrent requests would otherwise launch ten browsers
 * and trigger ten approval pushes to the operator's phone.
 */
export class EnvironmentLogin {
  #inFlight: Promise<SessionCredentials> | undefined;

  constructor(
    private readonly manager: LoginManager,
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
  ) {}

  async credentials(): Promise<SessionCredentials> {
    this.#inFlight ??= this.#run().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #run(): Promise<SessionCredentials> {
    this.log.info('signing in with the configured LinkedIn credentials');
    const outcome = await this.manager.start(this.username, this.password);

    if (outcome.status === 'authenticated') return outcome.credentials;

    if (outcome.status === 'challenge') {
      throw new AppError('CHALLENGE_REQUIRED', outcome.message, {
        hint: outcome.handle
          ? `Approve the sign-in, then POST /api/auth/verify with handle "${outcome.handle}".`
          : 'Clear the challenge in your own browser, then set LI_AT instead.',
        details: { handle: outcome.handle, challenge: outcome.kind },
      });
    }

    throw new AppError('LOGIN_FAILED', outcome.message);
  }
}
