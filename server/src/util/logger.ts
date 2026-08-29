import pino from 'pino';

/**
 * Redaction is not optional here. The outbound cookie header carries li_at (full
 * account access) and JSESSIONID — which LinkedIn also uses verbatim as the CSRF
 * token, so `data-csrf` is a credential too.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers.authorization',
  'req.headers["x-li-at"]',
  'req.headers["x-li-jsessionid"]',
  'req.headers["x-li-cookie"]',
  'req.headers["x-li-username"]',
  'req.headers["x-li-password"]',
  'req.body.credentials',
  // /api/auth/login carries these at the top level of the body, so the
  // credentials path above does not cover them.
  'req.body.username',
  'req.body.password',
  'req.body.handle',
  'req.body.code',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["csrf-token"]',
  'cookie',
  'csrf',
  'csrfToken',
  'li_at',
  'liAt',
  'jsessionid',
  'jsessionId',
  'apiKey',
  'password',
  'session_password',
  'username',
  'handle',
  'credentials',
  '*.cookie',
  '*.csrfToken',
  '*.password',
  '*.credentials',
];

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}
