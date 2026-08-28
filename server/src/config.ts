import { z } from 'zod';

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
   * A harvested browser session. This is the only way in: LinkedIn retired
   * form-based sign-in, so email and password cannot be exchanged for a session
   * by an HTTP client. JSESSIONID is optional but keeps the session stabler.
   */
  LI_AT: optionalStr,
  LI_JSESSIONID: optionalStr,
  LI_BCOOKIE: optionalStr,
  LI_LIDC: optionalStr,

  PROXY_URL: optionalStr.refine((v) => v === undefined || /^https?:\/\//i.test(v), {
    message: 'PROXY_URL must be an http(s) URL',
  }),

  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(3600),
  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
  OUTBOUND_RPM: z.coerce.number().int().positive().max(120).default(6),
  SECTION_CONCURRENCY: z.coerce.number().int().positive().max(10).default(3),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  /** False when no session is configured: the server boots, but its own lookups return NOT_CONFIGURED. */
  readonly hasCredentials: boolean;
  readonly authMode: 'cookie' | 'none';
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

  return {
    ...env,
    LI_JSESSIONID: jsession,
    hasCredentials: hasCookie,
    authMode: hasCookie ? 'cookie' : 'none',
    authEnabled: Boolean(env.API_KEY),
    isProduction: env.NODE_ENV === 'production',
  };
}
