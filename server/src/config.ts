import { z } from 'zod';
import type { AuthMode } from './linkedin/credentials.js';

/** Treats "" as absent, so a commented-out .env line and a blank one behave identically. */
const optionalStr = z
  .string()
  .transform((v) => (v.trim() === '' ? undefined : v.trim()))
  .optional();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  API_KEY: optionalStr,
  /**
   * Whether a caller may attach their own LinkedIn session to a request. On by
   * default so the API is usable without the operator lending out their account;
   * set to false to pin every lookup to the deployment's own session.
   */
  ALLOW_REQUEST_CREDENTIALS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Comma-separated allowed origins, or "*" to allow any. */
  CORS_ORIGIN: z.string().default('*'),
  /** Inbound requests per minute per client IP. Distinct from OUTBOUND_RPM. */
  INBOUND_RPM: z.coerce.number().int().positive().default(30),

  /**
   * A harvested browser session. The cheapest path in: no browser is launched
   * and no verification is needed. JSESSIONID is optional but keeps it stabler.
   */
  LI_AT: optionalStr,
  LI_JSESSIONID: optionalStr,
  LI_BCOOKIE: optionalStr,
  LI_LIDC: optionalStr,

  /**
   * The deployment's own LinkedIn account. Used only when LI_AT is absent: the
   * server signs in through a real browser and keeps the resulting cookie in
   * memory. Expect a one-time approval prompt on the account owner's phone the
   * first time a given host signs in, which is why LI_AT remains the better
   * choice for an unattended deploy.
   */
  LI_USERNAME: optionalStr,
  LI_PASSWORD: optionalStr,

  /**
   * Whether this deployment may launch Chromium to sign in. Off makes the API
   * cookie-only, which is right for a host with no browser and no spare memory.
   */
  /**
   * Whether a password sign-in may use LinkedIn's mobile-app auth endpoint
   * before falling back to driving the login form.
   *
   * On by default because the form is behind bot detection that answers a
   * headless browser with a CAPTCHA, and a CAPTCHA is unanswerable unattended.
   * The endpoint has no page to fingerprint, so it returns a verdict instead --
   * including, when LinkedIn wants a human, the challenge to hand to a browser.
   */
  API_LOGIN: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  BROWSER_LOGIN: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Headful is for debugging a sign-in locally; a server has no display. */
  BROWSER_HEADLESS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /**
   * How long one sign-in request may block waiting for a phone tap. Kept under
   * the 30s that most platform proxies allow before they cut the connection;
   * the caller polls for anything longer.
   */
  LOGIN_WAIT_MS: z.coerce.number().int().positive().max(60_000).default(20_000),
  /**
   * Set to a path to have a failed sign-in dump the page it got stuck on. Off by
   * default: the captures are session-bearing, so they are a debugging tool, not
   * something to leave running on a deployment.
   */
  LOGIN_DEBUG_DIR: z.string().trim().min(1).optional(),

  /**
   * Render profiles in Chromium instead of reading the HTML directly.
   *
   * On by default because it has to be: LinkedIn lazy-loads every section below
   * the top card through its server-driven-UI runtime, so the document fetched
   * over plain HTTP carries a name and a headline and nothing more. Turning this
   * off gives a fast, shallow profile -- useful on a host with no browser, and
   * honest about what it returns.
   */
  RENDER_PROFILES: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /**
   * Ceiling for one render, covering navigation plus the scroll that draws the
   * lazy sections in. Whatever has loaded when it expires is what gets returned.
   *
   * 45s rather than 30s because a long profile needs it: a capture of Satya
   * Nadella's ran out mid-scroll at 30s and came back missing Experience and
   * Education entirely. A partial profile is a silent wrong answer, so the
   * budget is set past the slow case rather than at the median.
   */
  RENDER_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(45_000),

  PROXY_URL: optionalStr.refine((v) => v === undefined || /^https?:\/\//i.test(v), {
    message: 'PROXY_URL must be an http(s) URL',
  }),

  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(3600),
  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
  OUTBOUND_RPM: z.coerce.number().int().positive().max(120).default(6),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  /** False when no session is configured: the server boots, but its own lookups return NOT_CONFIGURED. */
  readonly hasCredentials: boolean;
  readonly authMode: AuthMode;
  readonly authEnabled: boolean;
  readonly isProduction: boolean;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const jsession = env.LI_JSESSIONID?.replace(/^"|"$/g, '');
  const hasCookie = Boolean(env.LI_AT);
  // A password is only a way in if this deployment is allowed to open a browser,
  // so the two are reported as one fact rather than left for callers to combine.
  // Either route can complete a password sign-in now, so a deployment with no
  // browser still reports credentials mode when the API endpoint is available.
  const hasLogin = Boolean(
    env.LI_USERNAME && env.LI_PASSWORD && (env.API_LOGIN || env.BROWSER_LOGIN),
  );

  return {
    ...env,
    LI_JSESSIONID: jsession,
    hasCredentials: hasCookie || hasLogin,
    authMode: hasCookie ? 'cookie' : hasLogin ? 'credentials' : 'none',
    authEnabled: Boolean(env.API_KEY),
    isProduction: env.NODE_ENV === 'production',
  };
}
