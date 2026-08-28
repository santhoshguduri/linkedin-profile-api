/**
 * Error taxonomy. Every failure the API can produce maps to exactly one code so
 * clients can branch on `error.code` instead of parsing messages.
 */
/**
 * Listed as a value, not just a union, so the OpenAPI document enumerates the
 * exact same codes the server can emit instead of a hand-copied list.
 */
export const ERROR_CODES = [
  'INVALID_URL',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'NOT_CONFIGURED',
  'SESSION_INVALID',
  'CHALLENGE_REQUIRED',
  'LOGIN_UNSUPPORTED',
  'PROFILE_NOT_FOUND',
  'NOT_FOUND',
  'RATE_LIMITED',
  'UPSTREAM_THROTTLED',
  'UPSTREAM_ERROR',
  'TIMEOUT',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_CONFIGURED: 503,
  SESSION_INVALID: 401,
  CHALLENGE_REQUIRED: 403,
  LOGIN_UNSUPPORTED: 501,
  PROFILE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UPSTREAM_THROTTLED: 503,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
  INTERNAL: 500,
};

/** Operator-facing hints. Surfaced in the API response to make failures actionable. */
const HINTS: Partial<Record<ErrorCode, string>> = {
  SESSION_INVALID:
    'LinkedIn served the logged-out authwall. The li_at cookie is missing, expired or revoked — refresh it and redeploy.',
  CHALLENGE_REQUIRED:
    'LinkedIn served a checkpoint/captcha. Sign in from a browser, clear the challenge, then set LI_AT from that session -- a server cannot answer a CAPTCHA or an emailed PIN unattended.',
  LOGIN_UNSUPPORTED:
    'Send a li_at cookie instead: sign in to LinkedIn in a browser, then copy li_at from DevTools > Application > Cookies.',
  UPSTREAM_THROTTLED:
    'LinkedIn is rate limiting this IP (HTTP 999). Wait for the cooldown, lower OUTBOUND_RPM, or route through PROXY_URL.',
  NOT_CONFIGURED:
    'Configure LI_AT on the server, or send credentials with the request.',
  PROFILE_NOT_FOUND: 'No such public identifier, or the profile is not visible to this session.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  /** Overrides the code's default hint when one failure has several remedies. */
  readonly hint?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      details?: unknown;
      retryAfterSeconds?: number;
      cause?: unknown;
      hint?: string;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.hint = options.hint;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...((this.hint ?? HINTS[this.code]) ? { hint: this.hint ?? HINTS[this.code] } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(this.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: this.retryAfterSeconds }
          : {}),
      },
    };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
