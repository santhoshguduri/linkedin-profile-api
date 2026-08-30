/**
 * Email + password sign-in, driven through a real browser.
 *
 * Why a browser and not an HTTP call: LinkedIn's login page carries no <form>.
 * It is a server-driven-UI document whose sign-in action is declared as
 * `com.linkedin.sdui.requests.login.authenticate` with `"isEncrypted": true`,
 * and the request it builds is signed with an `apfc` device-fingerprint token
 * minted by LinkedIn's own JavaScript. Reproducing either outside a browser
 * means reimplementing code that changes without notice. Letting Chromium run
 * the page does it correctly by construction.
 *
 * What comes out the far end is still just `li_at`. Password sign-in is a way to
 * *acquire* a session cookie, not a different way to read profiles -- so
 * everything downstream of this file is unchanged, and a caller who already has
 * a cookie never loads this module at all.
 *
 * Playwright is imported lazily for that reason: a deployment that only serves
 * cookie-based lookups should not need ~150 MB of Chromium on disk to boot.
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { AppError } from '../util/errors.js';
import type { SessionCredentials } from './credentials.js';
import { DEFAULT_USER_AGENT } from './session.js';

/**
 * What LinkedIn is asking for, when it interrupts a sign-in.
 *
 * `app-approval` is the one worth calling out: LinkedIn pushes a notification to
 * the LinkedIn mobile app and the checkpoint page long-polls until it is tapped.
 * Nothing is typed anywhere, so it resolves purely by waiting -- which is why it
 * is handled by polling rather than by collecting an input.
 */
export type ChallengeKind = 'app-approval' | 'code' | 'captcha' | 'unknown';

export type LoginOutcome =
  | { status: 'authenticated'; credentials: SessionCredentials }
  | { status: 'challenge'; kind: ChallengeKind; message: string }
  | { status: 'failed'; message: string };

/** Human-readable prompt per challenge, surfaced straight to the caller's UI. */
export const CHALLENGE_MESSAGES: Record<ChallengeKind, string> = {
  'app-approval':
    'LinkedIn sent an approval request to the LinkedIn app on your phone. Open it and tap approve; this stays open while you do.',
  code: 'LinkedIn sent a verification code. Enter it to finish signing in.',
  captcha:
    'LinkedIn served a CAPTCHA, which cannot be solved unattended. Sign in from your own browser once to clear it, then try again.',
  unknown:
    'LinkedIn asked for an extra verification step. If your phone or email has a request from LinkedIn, approve it; this stays open while you do.',
};

/**
 * Everything LinkedIn can put on screen after a password is submitted, reduced
 * to one of four shapes.
 *
 * Split out as a pure function on purpose: it is the part most likely to need
 * adjusting when LinkedIn rewords a page, and it is the only part that can be
 * tested without launching a browser.
 *
 * Order matters. A CAPTCHA page also mentions "verification", and the app-
 * approval page also mentions a code (as the fallback offered underneath), so
 * the most specific signals are checked first.
 */
export function classifyChallenge(url: string, text: string, hasCodeInput = false): ChallengeKind {
  const haystack = `${url}\n${text}`.toLowerCase();

  if (/captcha|quick security check|are you a human|hcaptcha|funcaptcha/.test(haystack)) {
    return 'captcha';
  }

  // The wording drifts between locales and A/B tests, so several phrasings of
  // the same instruction are matched rather than one canonical string.
  if (
    /linkedin app|check your (linkedin )?app|approve th(is|e) (sign.?in|request)|we sent (a|you a) notification|tap (approve|yes)|open your linkedin app/.test(
      haystack,
    )
  ) {
    return 'app-approval';
  }

  if (
    hasCodeInput ||
    /verification code|enter the (6|six).digit|two.step verification|enter the code|security code|pin/.test(
      haystack,
    )
  ) {
    return 'code';
  }

  return 'unknown';
}

/**
 * Reads back the reason a sign-in was rejected outright, if the page gave one.
 * Returning LinkedIn's own wording is more useful than a generic failure: "we
 * do not recognise that email" and "that password is incorrect" send the caller
 * to different fixes.
 */
export function credentialErrorFrom(text: string): string | undefined {
  // Anchored on the distinctive phrase, then the rest of that line: LinkedIn
  // puts the remedy in a second sentence ("Please try again."), and cutting at
  // the first full stop would throw away the half that tells you what to do.
  const patterns = [
    /hmm,? we don'?t recognize that email.*/i,
    /that'?s not the right password.*/i,
    /the password you provided must have.*/i,
    /wrong email or password.*/i,
    /please enter a valid email address.*/i,
    /couldn'?t find a linkedin account.*/i,
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(text);
    if (hit) return hit[0].trim();
  }
  return undefined;
}

/**
 * Whether a pathname is still one of LinkedIn sign-in pages.
 *
 * Exported only so it can be tested, and it earned that. The word-boundary
 * anchor was once written as a bare backslash-b through a shell heredoc and
 * reached this file as a literal backspace byte, making the pattern match
 * nothing. Every pathname then looked like it had already left the login page,
 * so the wait loop returned on its first pass and judged the sign-in before
 * LinkedIn had answered -- which surfaced as "did not sign in and did not say
 * why" on a perfectly good password.
 */
export function isOnLoginPath(pathname: string): boolean {
  return /^\/(login|uas)(\b|$)/.test(pathname);
}

export interface BrowserLoginOptions {
  headless: boolean;
  /** Ceiling on any single navigation. Kept well under the HTTP request budget. */
  navigationTimeoutMs: number;
  proxyUrl?: string | undefined;
  userAgent?: string | undefined;
  /**
   * Where to dump the rendered page when a sign-in does not end in a cookie.
   * Unset in normal operation: these captures show a half-authenticated page and
   * the text can carry tokens, so they are opt-in and land in a gitignored dir.
   */
  debugDir?: string | undefined;
}

/**
 * Chromium flags. `AutomationControlled` is the one that matters: leaving it on
 * sets `navigator.webdriver`, which LinkedIn checks and answers with a CAPTCHA.
 * The rest are the standard container-safety flags -- shared memory in a slim
 * Docker image is too small for Chromium's default.
 */
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-gpu',
];

const LOGIN_URL = 'https://www.linkedin.com/login';

/**
 * How the sign-in page is actually built, as of a capture against the live page.
 *
 * Three things there make the obvious selectors useless:
 *
 *   - `id` is React's `useId` output -- `«r0»`, `«r3»`. It changes per render and
 *     is not even a valid CSS identifier, so `#username` matches nothing.
 *   - `name` is empty on every field, so `input[name="session_key"]` (the old
 *     /uas/login markup) matches nothing either.
 *   - Every field is rendered **twice**, once hidden and once visible, for the
 *     responsive layout. Taking `.first()` reliably picks the hidden copy, which
 *     cannot be filled.
 *
 * So: match on `type` and `autocomplete`, which are semantic and stable, and
 * filter to the visible copy every time. The legacy spellings are kept last as a
 * fallback, since LinkedIn still serves the old page to some flows.
 */
type Candidate = (page: Page) => Locator;

const USERNAME_CANDIDATES: Candidate[] = [
  // The live page renders `autocomplete="username webauthn"`, hence the prefix match.
  (page) => page.locator('input[autocomplete^="username"]'),
  (page) => page.locator('input[type="email"]'),
  (page) => page.locator('#username, input[name="session_key"]'),
];

const PASSWORD_CANDIDATES: Candidate[] = [
  (page) => page.locator('input[autocomplete="current-password"]'),
  (page) => page.locator('input[type="password"]'),
  (page) => page.locator('#password, input[name="session_password"]'),
];

const CODE_CANDIDATES: Candidate[] = [
  (page) => page.locator('input[autocomplete="one-time-code"]'),
  (page) => page.locator('input[name="pin"], input[name="verification_code"]'),
  (page) => page.locator('input[type="tel"], input[inputmode="numeric"]'),
];

/**
 * Anchored so "Sign in with Microsoft" and "Sign in with Apple" -- both present
 * on the page, both buttons -- cannot be clicked by mistake.
 */
const SUBMIT_CANDIDATES: Candidate[] = [
  (page) => page.getByRole('button', { name: /^\s*sign in\s*$/i }),
  (page) => page.getByRole('button', { name: /^\s*(submit|verify|continue|done)\s*$/i }),
  (page) => page.locator('button[type="submit"]'),
];

/** The first candidate with a visible match, or undefined if none has one. */
async function firstVisible(
  page: Page,
  candidates: Candidate[],
  timeoutMs: number,
): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const locator = candidate(page).filter({ visible: true }).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return locator;
    } catch {
      /* try the next spelling */
    }
  }
  return undefined;
}

/**
 * One sign-in attempt, holding the browser open across a challenge.
 *
 * The instance is deliberately long-lived: an app-approval challenge is resolved
 * by LinkedIn's own page finishing a long-poll, so the tab that started the
 * sign-in has to be the tab that finishes it. Closing and reopening would lose
 * the checkpoint and start over.
 */
export class BrowserLogin {
  private constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly options: BrowserLoginOptions,
  ) {}

  static async open(options: BrowserLoginOptions): Promise<BrowserLogin> {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch (cause) {
      throw new AppError(
        'LOGIN_UNAVAILABLE',
        'Password sign-in needs Playwright, which is not installed in this deployment.',
        { cause },
      );
    }

    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    // Pin it back onto the options so `harvest()` reports the UA this browser
    // really used, not whatever the default happens to be when it is read.
    options = { ...options, userAgent };
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: options.headless,
        args: LAUNCH_ARGS,
        ...(options.proxyUrl ? { proxy: { server: options.proxyUrl } } : {}),
      });
    } catch (cause) {
      throw new AppError(
        'LOGIN_UNAVAILABLE',
        'Could not start Chromium. Run "npx playwright install chromium" on the host.',
        { cause },
      );
    }

    // Locale, timezone and viewport are set together: a browser reporting a
    // 1280x720 window with no timezone is as distinctive as one reporting
    // navigator.webdriver.
    const context = await browser.newContext({
      userAgent,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      viewport: { width: 1440, height: 900 },
    });
    context.setDefaultTimeout(options.navigationTimeoutMs);

    const page = await context.newPage();
    return new BrowserLogin(browser, context, page, options);
  }

  /** Best-effort teardown. A browser that fails to close must not fail a request. */
  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  /**
   * Types the credentials and submits, then reports whatever LinkedIn did next.
   *
   * The password is typed rather than assigned, because the page's own handlers
   * are what encrypt it before it leaves; a value set directly on the element
   * skips the input events those handlers listen for.
   */
  async signIn(username: string, password: string): Promise<LoginOutcome> {
    await this.page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: this.options.navigationTimeoutMs,
    });

    const userField = await firstVisible(this.page, USERNAME_CANDIDATES, 8_000);
    const passField = await firstVisible(this.page, PASSWORD_CANDIDATES, 4_000);
    if (!userField || !passField) {
      throw new AppError(
        'LOGIN_FAILED',
        'LinkedIn served a sign-in page this API could not fill in.',
        { hint: 'LinkedIn has likely changed its login markup. Use a cookie instead.' },
      );
    }

    await userField.fill(username);
    await passField.fill(password);

    const submit = await firstVisible(this.page, SUBMIT_CANDIDATES, 3_000);
    if (submit) await submit.click();
    else await passField.press('Enter');

    await this.#settle();
    return this.state();
  }

  /**
   * Waits for a submitted page to resolve into something worth reading.
   *
   * Not `waitForLoadState('networkidle')`: LinkedIn holds long-poll connections
   * open indefinitely, so networkidle never fires and waiting for it burns the
   * entire timeout on every single sign-in. Instead this watches for the four
   * things that actually mean "done" -- a cookie appeared, the URL left the
   * login page, the page is complaining about the credentials, or the password
   * field was swapped out for the next step -- and returns the moment any of
   * them is true.
   */
  async #settle(budgetMs = 20_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (await this.harvest()) return;
      if (!isOnLoginPath(new URL(this.page.url()).pathname)) return;
      const text = await this.page.locator('body').innerText().catch(() => '');
      if (credentialErrorFrom(text)) return;

      // The password field going away means LinkedIn accepted it and swapped in the
      // next step -- which it can do without navigating, so watching the URL alone
      // would sit here for the whole budget with the answer already on screen.
      if (!(await firstVisible(this.page, PASSWORD_CANDIDATES, 250))) {
        await this.#awaitChallengeScreen();
        return;
      }
      await this.page.waitForTimeout(500);
    }
  }

  /**
   * Waits for the screen that replaced the password form to say what it wants.
   *
   * The password field vanishes the instant LinkedIn accepts the password, but
   * the screen it swaps in is rendered by the SDUI runtime a beat later. Reading
   * the page at that exact moment finds an empty body, `classifyChallenge` has
   * nothing to match on and answers `unknown` -- and an unrecognised challenge
   * used to end the sign-in outright. So a perfectly ordinary two-factor login
   * failed about five seconds in, with a message saying the verification step
   * was not recognised, while the approval push was still on its way to the
   * phone.
   *
   * Bounded and best-effort: if the screen is still illegible when the budget
   * runs out, the sign-in is parked as `unknown` and waited on anyway rather
   * than abandoned. The budget is small for that reason -- and because it is
   * spent inside the same HTTP request as the first approval wait, which has to
   * stay under the ~30s most platform proxies allow.
   */
  async #awaitChallengeScreen(budgetMs = 6_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      // A cookie means the challenge resolved itself while we were looking.
      if (await this.harvest()) return;
      const text = await this.page.locator('body').innerText().catch(() => '');
      if (classifyChallenge(this.page.url(), text) !== 'unknown') return;
      if (await firstVisible(this.page, CODE_CANDIDATES, 250)) return;
      await this.page.waitForTimeout(400);
    }
  }

  /**
   * Where the sign-in currently stands.
   *
   * The cookie is checked before the page is read, because the moment `li_at`
   * exists the sign-in has succeeded regardless of what is still on screen --
   * the checkpoint page often lingers for a beat after the redirect fires.
   */
  async state(): Promise<LoginOutcome> {
    const harvested = await this.harvest();
    if (harvested) return { status: 'authenticated', credentials: harvested };

    const url = this.page.url();
    const text = await this.page.locator('body').innerText().catch(() => '');

    const rejection = credentialErrorFrom(text);
    if (rejection) return { status: 'failed', message: rejection };

    const hasCodeInput = Boolean(await firstVisible(this.page, CODE_CANDIDATES, 750));

    /**
     * Whether the password was accepted, decided by the password field rather
     * than by the address bar.
     *
     * This is the crux of the whole flow. The old check gated on the URL
     * containing "checkpoint" -- but LinkedIn's SDUI login swaps the approval
     * screen in *without navigating*, so the URL can still read /login while
     * the phone is already buzzing. An app-approval screen also has no input to
     * find. So neither gate fired, and a perfectly normal two-factor sign-in was
     * reported as "did not sign in and did not say why".
     *
     * The password field vanishing is the reliable signal: LinkedIn only takes
     * it off screen once it has accepted it and moved to the next step. If it is
     * still there, nothing was accepted.
     */
    const passwordGone = !(await firstVisible(this.page, PASSWORD_CANDIDATES, 500));
    const onCheckpointUrl = /checkpoint|challenge|verif/i.test(url);

    if (onCheckpointUrl || hasCodeInput || passwordGone) {
      const kind = classifyChallenge(url, text, hasCodeInput);
      await this.#capture(`challenge-${kind}`);
      return { status: 'challenge', kind, message: CHALLENGE_MESSAGES[kind] };
    }

    // Password field still on screen and LinkedIn is not complaining: the click
    // never took effect. Says so plainly rather than blaming the credentials,
    // because the credentials are the one thing this case rules out.
    await this.#capture('no-progress');
    return {
      status: 'failed',
      message:
        'LinkedIn did not move past the sign-in form. The password was not rejected -- the form simply did not submit, which usually means LinkedIn changed its login markup.',
    };
  }

  /**
   * Writes what LinkedIn actually showed to disk, when a debug directory is set.
   *
   * A sign-in that stalls is close to undiagnosable from an error string alone:
   * the useful information is the rendered page, and it is gone the moment the
   * browser closes. Off unless LOGIN_DEBUG_DIR is set, because these captures
   * are session-bearing -- the screenshot shows a signed-in-adjacent page and
   * the HTML can carry tokens.
   */
  async #capture(reason: string): Promise<void> {
    const dir = this.options.debugDir;
    if (!dir) return;
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = join(dir, `${stamp}-${reason}`);
      const text = await this.page.locator('body').innerText().catch(() => '');
      await writeFile(`${base}.txt`, `url: ${this.page.url()}

${text}
`, 'utf8');
      await this.page.screenshot({ path: `${base}.png`, fullPage: true });
    } catch {
      /* diagnostics must never break a sign-in */
    }
  }

  /**
   * Waits out an app-approval challenge.
   *
   * Bounded by `budgetMs` rather than by the whole challenge lifetime, so one
   * HTTP request never hangs waiting for a human. When the budget runs out the
   * browser stays open and the caller polls again -- the phone tap can land on
   * any one of those polls.
   */
  async waitForApproval(budgetMs: number): Promise<LoginOutcome> {
    const deadline = Date.now() + budgetMs;
    do {
      const harvested = await this.harvest();
      if (harvested) return { status: 'authenticated', credentials: harvested };
      await this.page.waitForTimeout(1_500);
    } while (Date.now() < deadline);

    return this.state();
  }

  /** Answers an emailed or texted verification code. */
  async submitCode(code: string): Promise<LoginOutcome> {
    const field = await firstVisible(this.page, CODE_CANDIDATES, 5_000);
    if (!field) {
      throw new AppError('LOGIN_FAILED', 'LinkedIn is not asking for a verification code.', {
        hint: 'Poll the challenge again -- the required step may have changed.',
      });
    }

    await field.fill(code.trim());
    const submit = await firstVisible(this.page, SUBMIT_CANDIDATES, 3_000);
    if (submit) await submit.click();
    else await field.press('Enter');

    await this.#settle();
    const outcome = await this.state();
    // A wrong code leaves the page on the same checkpoint, which would otherwise
    // read as "still waiting" and hide the mistake.
    if (outcome.status === 'challenge' && outcome.kind === 'code') {
      const text = await this.page.locator('body').innerText().catch(() => '');
      if (/incorrect|didn'?t match|try again|not valid/i.test(text)) {
        return { status: 'challenge', kind: 'code', message: 'That code was not accepted. Check it and try again.' };
      }
    }
    return outcome;
  }

  /**
   * Pulls the session cookies out of the browser context.
   *
   * `li_at` is HttpOnly, so this is the only place it can be read from -- and it
   * is read once, at the end, after which the browser is thrown away. LinkedIn
   * stores JSESSIONID quoted; the quotes are stripped so the value matches the
   * `data-csrf` form the fetcher sends.
   */
  async harvest(): Promise<SessionCredentials | undefined> {
    const cookies = await this.context.cookies('https://www.linkedin.com').catch(() => []);
    const liAt = cookies.find((c) => c.name === 'li_at')?.value;
    if (!liAt) return undefined;

    const jsessionId = cookies.find((c) => c.name === 'JSESSIONID')?.value?.replace(/^"|"$/g, '');
    // The UA travels with the cookie. LinkedIn issued this session to *this*
    // browser, and later lookups replay it over plain HTTP -- if those requests
    // announce a different client than the one that signed in, the mismatch is
    // visible to LinkedIn and is a cheap reason to invalidate the session.
    return {
      liAt,
      ...(jsessionId ? { jsessionId } : {}),
      userAgent: this.options.userAgent ?? DEFAULT_USER_AGENT,
    };
  }
}
