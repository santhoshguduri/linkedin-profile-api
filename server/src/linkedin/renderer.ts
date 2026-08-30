/**
 * Renders a profile in a real browser, because the HTML alone no longer has the
 * profile in it.
 *
 * LinkedIn moved the profile page to server-driven UI. What the document
 * carries is a shell: the top card, and a set of lazy-load anchors naming the
 * components that will replace them --
 *
 *   profile-top-card-experience-lazy-load-<slug>
 *   com.linkedin.sdui.generated.profile.dsl.impl.profileCardsExperienceOnly
 *   com.linkedin.sdui.generated.profile.dsl.impl.profileCardsBelowActivityPart1..7
 *
 * Each is fetched afterwards by the page's own runtime as an
 * `AsyncComponentRequest`. Fetching the document over plain HTTP therefore
 * yields 55 text runs -- a name, a headline, a follower count, a menu, a footer
 * -- and nothing else. Not one experience entry. The /details/<section>/ routes
 * and the contact-info overlay return that same shell, so there is no cheaper
 * URL to ask instead.
 *
 * Replaying those async requests by hand would mean reimplementing the SDUI
 * protocol against component ids that are regenerated on LinkedIn's release
 * cadence. Letting Chromium do it costs seconds and keeps working across those
 * releases, so that is the trade made here.
 */
import { existsSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { AppError } from '../util/errors.js';
import type { SessionCredentials } from './credentials.js';
import { DEFAULT_USER_AGENT, detectAuthState } from './session.js';

export interface RenderOptions {
  credentials: SessionCredentials;
  headless: boolean;
  timeoutMs: number;
  proxyUrl?: string | undefined;
}

/** Chromium flags that keep it alive in a container and quiet about automation. */
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
];

/**
 * Trimmed to what a lazy section needs to render. Images and fonts are the bulk
 * of a profile's bytes and none of its text; blocking them cuts render time
 * roughly in half. `img` is deliberately *not* blocked -- profile and company
 * logos are part of the response contract, and we need their URLs from the DOM.
 */
const BLOCKED_RESOURCES = new Set(['font', 'media', 'stylesheet']);

let shared: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;

/** null until the probe below has run; the answer is stable for the process. */
let chromiumPresent: boolean | null = null;

/**
 * Whether a Chromium binary is on disk, which is a different question from
 * whether this deployment is allowed to launch one.
 *
 * BROWSER_LOGIN answers permission and defaults to true, so a host that simply
 * has no browser -- a serverless function, a plain Node buildpack -- used to
 * advertise password sign-in in /api/status. The client believed it, offered the
 * form, and the caller learned otherwise from a 501 after typing a password.
 * Capability is checkable, so it gets checked.
 */
export async function probeChromium(): Promise<boolean> {
  if (chromiumPresent !== null) return chromiumPresent;
  try {
    const { chromium } = await import('playwright');
    const path = chromium.executablePath();
    chromiumPresent = path.length > 0 && existsSync(path);
  } catch {
    // No playwright package, or a build with no browser registry behind it.
    chromiumPresent = false;
  }
  return chromiumPresent;
}

/**
 * The probe's last answer, or null while it is still running.
 *
 * Callers that cannot await -- the status getter is a synchronous property --
 * should read null as "assume yes". The probe is kicked off when the app is
 * built and settles in milliseconds, so the optimistic window closes long
 * before a request arrives, and being briefly wrong in that direction only
 * repeats today's behaviour rather than adding a new one.
 */
export const chromiumKnown = (): boolean | null => chromiumPresent;

/**
 * One browser process, reused across requests and shut down once idle.
 *
 * A Chromium launch is roughly a second and ~100 MB; paying that per lookup
 * would dominate the request. Holding it open forever on a small dyno is just as
 * bad, so it closes after a stretch with no traffic and relaunches on demand.
 */
async function browserFor(options: RenderOptions): Promise<Browser> {
  if (shared?.isConnected()) return shared;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (cause) {
    throw new AppError(
      'UPSTREAM_ERROR',
      'Reading a profile needs Playwright, which is not installed in this deployment.',
      { cause },
    );
  }

  try {
    shared = await chromium.launch({
      headless: options.headless,
      args: LAUNCH_ARGS,
      ...(options.proxyUrl ? { proxy: { server: options.proxyUrl } } : {}),
    });
  } catch (cause) {
    throw new AppError(
      'UPSTREAM_ERROR',
      'Could not start Chromium. Run "npx playwright install chromium" on the host.',
      { cause },
    );
  }
  return shared;
}

/** Pushes the idle shutdown out; called after every render. */
function touch(idleMs: number): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void shared?.close().catch(() => {});
    shared = null;
  }, idleMs);
  idleTimer.unref?.();
}

/** Releases the shared browser. Exported for tests and graceful shutdown. */
export async function closeRenderer(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const browser = shared;
  shared = null;
  await browser?.close().catch(() => {});
}

/** Seeds the context with the caller's session, in the shape Chromium wants. */
async function seedSession(context: BrowserContext, credentials: SessionCredentials) {
  const base = { domain: '.www.linkedin.com', path: '/', secure: true } as const;
  const cookies = [];
  if (credentials.liAt) {
    cookies.push({ ...base, name: 'li_at', value: credentials.liAt, httpOnly: true });
  }
  if (credentials.jsessionId) {
    // Quoted on the wire, and LinkedIn compares it byte-for-byte against the
    // csrf-token header its own scripts send, so the quotes have to survive.
    cookies.push({
      ...base,
      name: 'JSESSIONID',
      value: `"${credentials.jsessionId}"`,
      httpOnly: false,
    });
  }
  await context.addCookies(cookies);
}

/**
 * The wall's own form classes, which appear nowhere on a real profile: 8 hits
 * across a captured wall, 0 across a captured authenticated profile.
 *
 * `detectAuthState` is not enough on its own here. It looks for `/authwall?trk=`
 * and a quoted `"authwall"` in the first 4 KB, which is what a raw HTTP body
 * carries -- but after hydration those are gone and what remains is
 * `class="authwall-join-form__title"`, which matches neither.
 */
const AUTHWALL_MARKUP = /authwall-(join|sign-in)-form/;

/**
 * Throws if the markup is LinkedIn's join/sign-in wall rather than a profile.
 *
 * Called twice, before and after the scroll, and it has to be. LinkedIn serves
 * the profile shell first and only swaps in the wall a moment later, so a single
 * check on arrival passes a session that is about to be refused -- the observed
 * sequence is a 679 KB shell that becomes a 76 KB wall mid-render.
 */
function rejectAuthwall(html: string): void {
  if (!AUTHWALL_MARKUP.test(html) && detectAuthState(200, html) !== 'authwall') return;
  throw new AppError(
    'SESSION_INVALID',
    'LinkedIn served the sign-in wall instead of the profile. The session cookie is expired or was rejected.',
  );
}

/**
 * `page.content()`, retried.
 *
 * Serialising the DOM fails outright if a navigation commits mid-call, and
 * LinkedIn redirects more than once while it decides whether the session is
 * good. Retrying is enough: the interruption is a moment long, and the caller
 * has a real deadline of its own to stop against.
 */
async function contentOf(page: Page, attempts = 4): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await page.content();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await page.waitForTimeout(400).catch(() => {});
    }
  }
}

/**
 * Streaming transports, which never "finish" and so can never be waited on.
 *
 * LinkedIn holds long-poll and websocket connections open for the life of the
 * page. Counting those as outstanding work would mean the settle check below
 * never passes and every render burned its entire timeout budget.
 */
const STREAMING = new Set(['eventsource', 'websocket']);

/** A request older than this is treated as abandoned rather than pending. */
const IN_FLIGHT_TTL_MS = 8_000;

/**
 * Counts requests the page has started but not finished.
 *
 * The lazy sections arrive as network responses, and a section still in flight
 * looks exactly like a section that will never come: the page has stopped
 * growing either way. Without this the scroll declares victory during the gap
 * between asking for a card and receiving it -- which is how a capture of Satya
 * Nadella's profile came back with Activity as its last section and no
 * Experience or Education at all.
 *
 * Start times are kept, not just a tally, so that a request which is merely slow
 * cannot stall the loop indefinitely; past the TTL it stops counting.
 */
function trackInFlight(page: Page, now: () => number): () => number {
  const started = new Map<unknown, number>();
  page.on('request', (request) => {
    if (!STREAMING.has(request.resourceType())) started.set(request, now());
  });
  const settle = (request: unknown) => started.delete(request);
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);

  return () => {
    const cutoff = now() - IN_FLIGHT_TTL_MS;
    let pending = 0;
    for (const [request, at] of started) {
      if (at >= cutoff) pending += 1;
      else started.delete(request);
    }
    return pending;
  };
}

interface ScrollProbe {
  height: number;
  text: number;
  atBottom: boolean;
}

/**
 * Scroll one viewport and report what changed.
 *
 * Passed to Playwright as source text rather than a closure because this file is
 * compiled against Node's lib, where `window` and `document` do not exist. The
 * string is evaluated in the page, which has both.
 */
const SCROLL_STEP = `(() => {
  window.scrollBy(0, Math.round(window.innerHeight * 0.9));
  return {
    height: document.body.scrollHeight,
    text: document.body.innerText.length,
    atBottom: window.innerHeight + window.scrollY >= document.body.scrollHeight - 200,
  };
})()`;

/**
 * Scrolls the page until it stops growing.
 *
 * The lazy sections are triggered by viewport proximity, and each one that
 * arrives makes the page taller, which can bring the next trigger into range --
 * so this is a loop, not a single jump to the bottom. It settles only once the
 * height, the rendered text and the in-flight request count have all held still
 * across consecutive passes, which is the closest thing to a completion signal
 * available: `networkidle` never fires on LinkedIn, whose long-poll connections
 * stay open for the life of the page.
 */
async function drainLazySections(page: Page, deadline: number): Promise<void> {
  const inFlight = trackInFlight(page, Date.now);
  let stable = 0;
  let previous = { height: 0, text: 0 };

  while (Date.now() < deadline && stable < 4) {
    const current = await page.evaluate<ScrollProbe>(SCROLL_STEP).catch(() => null);
    if (!current) return;

    const quiet =
      current.atBottom &&
      inFlight() === 0 &&
      current.height === previous.height &&
      current.text === previous.text;
    stable = quiet ? stable + 1 : 0;
    previous = { height: current.height, text: current.text };
    await page.waitForTimeout(500);
  }
}

/**
 * A rendered profile, plus the details pages it says are truncated.
 *
 * Keyed by the route segment -- `skills`, `certifications` -- exactly as it
 * appears in `/in/<slug>/details/<route>/`.
 */
export interface RenderedProfile {
  html: string;
  details: Map<string, string>;
}

/**
 * Loads a profile, and then any `/details/<route>/` page it links to.
 *
 * The profile card shows only the first two or three entries of a long section
 * behind a "Show all 40 skills" link. Fetching that link over HTTP returns the
 * same empty shell as everything else -- but rendering it does not, because it
 * is the same SDUI app and its runtime fetches its own cards just as the profile
 * page does. So the details pages are reached the only way they can be.
 *
 * All of it happens in one browser context: the session is already seeded, the
 * connection is already warm, and a second `newContext` would pay both again for
 * every section.
 *
 * Returns whatever arrived before the budget ran out rather than throwing. A
 * profile with four of six sections filled is worth returning; the caller
 * reports the rest in `meta.missingSections`.
 */
export async function renderProfile(
  url: string,
  options: RenderOptions,
  /**
   * Which details pages to visit, decided from the rendered profile. Passed in
   * rather than computed here so this module stays free of extraction concerns;
   * `extract/rendered.ts` owns the question of what "truncated" looks like.
   */
  selectDetails: (html: string) => Iterable<string> = () => [],
): Promise<RenderedProfile> {
  const browser = await browserFor(options);
  const userAgent = options.credentials.userAgent?.trim() || DEFAULT_USER_AGENT;
  const deadline = Date.now() + options.timeoutMs;

  const context = await browser.newContext({
    userAgent,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1440, height: 900 },
  });

  try {
    await seedSession(context, options.credentials);
    await context.route('**/*', (route) =>
      BLOCKED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue(),
    );

    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs);

    // `load` would wait on assets we just blocked, and `networkidle` never
    // arrives; the SDUI runtime starts on DOMContentLoaded, which is the event
    // that actually matters here.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });

    // Checked on content rather than on the URL. A rejected session gets the
    // join/sign-in wall rendered in place, under the profile's own URL and an
    // HTTP 200 -- so neither the path nor the status code gives it away, and a
    // 68 KB wall would otherwise parse as a profile with every field empty.
    rejectAuthwall(await contentOf(page));

    // The top card is server-rendered, so this resolves almost immediately; it
    // exists to fail fast on a page that never rendered at all.
    await page
      .waitForSelector('main', { timeout: Math.max(2_000, options.timeoutMs / 4) })
      .catch(() => {});
    await drainLazySections(page, deadline);

    const html = await contentOf(page);
    rejectAuthwall(html);

    const details = new Map<string, string>();
    for (const route of selectDetails(html)) {
      // Each page gets whatever is left of the overall budget, so a slow profile
      // costs sections rather than failing the lookup outright.
      if (Date.now() >= deadline - 3_000) break;
      try {
        await page.goto(`${url}details/${route}/`, {
          waitUntil: 'domcontentloaded',
          timeout: Math.max(5_000, deadline - Date.now()),
        });
        await page.waitForSelector('main', { timeout: 5_000 }).catch(() => {});
        await drainLazySections(page, deadline);
        const section = await contentOf(page);
        rejectAuthwall(section);
        details.set(route, section);
      } catch {
        /* a section that will not load is a missing section, not a failed lookup */
      }
    }

    return { html, details };
  } finally {
    await context.close().catch(() => {});
    touch(60_000);
  }
}