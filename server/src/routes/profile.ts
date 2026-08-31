/**
 * Profile routes, mounted at /api/profile. Request shape is validated here;
 * everything past that is the service's job.
 */
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../util/errors.js';
import {
  hasAnyCredential,
  mergeCredentials,
  parseCookieHeader,
  type SessionCredentials,
} from '../linkedin/credentials.js';
import type { Config } from '../config.js';
import type { ProfileService } from '../service.js';

/**
 * The session a caller may attach to a single lookup. Nothing here is stored:
 * it lives in memory only while it stays in use, then it is dropped.
 *
 * Three spellings of the same thing, because three different people arrive with
 * it in three different shapes: `liAt` from the browser extension, `cookie` from
 * someone who copied the whole request header, and `jsessionId` alongside either.
 *
 * `username`/`password` are the fourth: the server signs in through a browser,
 * harvests the cookie and uses it for this one lookup. It is the slowest path by
 * far -- and if LinkedIn asks for a phone approval it cannot complete inside a
 * single request -- so the response says so and points at /api/auth/login, where
 * the sign-in can be driven properly and the cookie reused.
 */
const CredentialsSchema = z.object({
  liAt: z.string().min(1).optional(),
  jsessionId: z.string().optional(),
  /** A pasted `Cookie:` header, a DevTools cookie table, or a bare li_at value. */
  cookie: z.string().optional(),
  /**
   * The browser the cookie was minted under, echoed back from a sign-in. Sent so
   * the lookup can present itself to LinkedIn as the client that earned the
   * session rather than as this server's default.
   */
  userAgent: z.string().max(256).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});

/**
 * A query string carries `refresh` as text, a JSON body carries it as a boolean.
 * One schema accepts both so GET and POST cannot drift apart.
 */
const RequestSchema = z.object({
  url: z.string().min(1, 'url is required'),
  refresh: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
  credentials: CredentialsSchema.optional(),
});

/**
 * Headers are the transport for GET, where there is no body. All three are in
 * the logger's redaction list, so none of them reaches a log line.
 */
function credentialsFromHeaders(req: Request): SessionCredentials {
  return mergeCredentials(
    { liAt: req.get('x-li-at'), jsessionId: req.get('x-li-jsessionid') },
    parseCookieHeader(req.get('x-li-cookie')),
  );
}

export function profileRouter(service: ProfileService, config: Config): Router {
  const router = Router();

  /**
   * Express 5 forwards a rejected promise from an async handler to the error
   * middleware on its own, so handlers throw `AppError` directly instead of
   * threading `next` through every failure path.
   */
  const lookup =
    (read: (req: Request) => unknown): RequestHandler =>
    async (req, res) => {
      const parsed = RequestSchema.safeParse(read(req));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const code = issue?.path[0] === 'credentials' ? 'BAD_REQUEST' : 'INVALID_URL';
        throw new AppError(code, issue?.message ?? 'Invalid request.', {
          details: parsed.error.issues,
        });
      }

      const body = parsed.data.credentials;

      // Password path: exchange the credentials for a cookie first, then fall
      // through to the ordinary lookup with it. Anything that needs a human --
      // an app approval, a code -- surfaces as CHALLENGE_PENDING with a handle,
      // which the caller finishes at /api/auth/verify.
      const username = (body?.username ?? req.get('x-li-username'))?.trim();
      const password = body?.password ?? req.get('x-li-password');
      if (username && password) {
        if (!config.ALLOW_REQUEST_CREDENTIALS) {
          throw new AppError(
            'BAD_REQUEST',
            'This deployment does not accept LinkedIn credentials on the request.',
          );
        }
        const progress = await service.logins.start(username, password);
        if (progress.status === 'failed') throw new AppError('LOGIN_FAILED', progress.message);
        if (progress.status === 'challenge') {
          throw new AppError(
            progress.handle ? 'CHALLENGE_PENDING' : 'CHALLENGE_REQUIRED',
            progress.message,
            { details: { handle: progress.handle, challenge: progress.kind } },
          );
        }

        res.json(
          await service.getProfile(parsed.data.url, {
            refresh: parsed.data.refresh,
            credentials: progress.credentials,
          }),
        );
        return;
      }

      if (username || password) {
        throw new AppError('BAD_REQUEST', 'Both username and password are required to sign in.');
      }

      // Rebuilt field by field so nothing beyond the cookie pair can travel on.
      // A pasted header carries analytics and fingerprinting cookies too; those
      // are dropped here rather than forwarded to LinkedIn on the caller's behalf.
      const supplied: SessionCredentials = body
        ? mergeCredentials(
            { liAt: body.liAt, jsessionId: body.jsessionId, userAgent: body.userAgent },
            parseCookieHeader(body.cookie),
          )
        : credentialsFromHeaders(req);

      // A paste that produced nothing usable is a mistake worth naming. Falling
      // through to NOT_CONFIGURED would tell them the server has no session,
      // which is not what went wrong.
      if ((body?.cookie?.trim() || req.get('x-li-cookie')) && !supplied.liAt) {
        throw new AppError('BAD_REQUEST', 'The pasted cookie did not contain an li_at value.', {
          hint: 'Copy the whole Cookie: request header from DevTools > Network, or use the browser extension.',
        });
      }

      const credentials = hasAnyCredential(supplied) ? supplied : undefined;

      if (credentials && !config.ALLOW_REQUEST_CREDENTIALS) {
        throw new AppError(
          'BAD_REQUEST',
          'This deployment does not accept LinkedIn credentials on the request.',
          { hint: 'Drop the credentials and use the session configured on the server.' },
        );
      }

      res.json(
        await service.getProfile(parsed.data.url, {
          refresh: parsed.data.refresh,
          credentials,
        }),
      );
    };

  router.get('/', lookup((req) => req.query));

  // POST takes the same payload in a body, which keeps profile URLs — and any
  // credentials — out of access logs and proxy history.
  router.post('/', lookup((req) => req.body));

  return router;
}
