/**
 * Sign-in routes, mounted at /api/auth.
 *
 * Three endpoints because a LinkedIn sign-in has three possible shapes: it
 * works, it needs a tap on a phone, or it needs a code typed in. `login` starts
 * one, `verify` picks a parked one back up, `cancel` throws it away.
 *
 * The harvested cookie is handed back to the caller rather than kept here. That
 * is deliberate and it is the same contract the cookie-paste path already uses:
 * the server holds no user sessions, so there is nothing on it to steal and
 * nothing to expire. The caller keeps the cookie for as long as it wants it and
 * attaches it to lookups.
 */
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../util/errors.js';
import type { LoginProgress } from '../linkedin/loginManager.js';
import type { Config } from '../config.js';
import type { ProfileService } from '../service.js';

const LoginSchema = z.object({
  username: z
    .string({ required_error: 'username is required' })
    .trim()
    .min(1, 'username is required'),
  password: z
    .string({ required_error: 'password is required' })
    .min(1, 'password is required'),
});

const VerifySchema = z.object({
  handle: z.string({ required_error: 'handle is required' }).trim().min(1, 'handle is required'),
  /** Present only for a code challenge; an app approval is resolved by waiting. */
  code: z.string().trim().optional(),
});

const CancelSchema = z.object({
  handle: z.string({ required_error: 'handle is required' }).trim().min(1, 'handle is required'),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('BAD_REQUEST', result.error.issues[0]?.message ?? 'Invalid request.', {
      details: result.error.issues,
    });
  }
  return result.data;
}

/**
 * Turns an outcome into a response.
 *
 * A failed sign-in becomes an error rather than a 200 with `status: "failed"`,
 * so a client that only checks `res.ok` still notices. A challenge stays a 428:
 * the request was well-formed, but something has to happen off-screen first.
 */
function respond(progress: LoginProgress) {
  if (progress.status === 'authenticated') {
    return {
      status: 'authenticated' as const,
      credentials: progress.credentials,
    };
  }

  if (progress.status === 'failed') {
    throw new AppError('LOGIN_FAILED', progress.message);
  }

  if (!progress.handle) {
    // Terminal challenge: a CAPTCHA, or something unrecognised. There is no
    // handle because there is no step this API could take next.
    throw new AppError('CHALLENGE_REQUIRED', progress.message, {
      details: { challenge: progress.kind },
    });
  }

  throw new AppError('CHALLENGE_PENDING', progress.message, {
    details: { handle: progress.handle, challenge: progress.kind },
  });
}

export function authRouter(service: ProfileService, config: Config): Router {
  const router = Router();

  const guard: RequestHandler = (_req, _res, next) => {
    if (!config.BROWSER_LOGIN) {
      next(
        new AppError('LOGIN_UNAVAILABLE', 'Password sign-in is switched off on this deployment.'),
      );
      return;
    }
    if (!config.ALLOW_REQUEST_CREDENTIALS) {
      next(
        new AppError(
          'BAD_REQUEST',
          'This deployment does not accept caller sign-ins; every lookup uses its own session.',
        ),
      );
      return;
    }
    next();
  };

  /**
   * Starts a sign-in. Blocks for up to LOGIN_WAIT_MS, because an approval push
   * is often tapped within a few seconds and it is better to answer
   * "authenticated" once than to make the client poll for something that has
   * already happened.
   */
  router.post('/login', guard, async (req, res) => {
    const { username, password } = parse(LoginSchema, req.body);
    res.json(respond(await service.logins.start(username, password)));
  });

  /**
   * Resumes a parked sign-in. With no `code` this polls the app approval; with
   * one it answers a verification code. Either way it blocks for at most
   * LOGIN_WAIT_MS and then reports where things stand, so a client loops on it.
   */
  router.post('/verify', guard, async (req, res) => {
    const { handle, code } = parse(VerifySchema, req.body);
    res.json(respond(await service.logins.resume(handle, code)));
  });

  /** Frees the browser behind a sign-in nobody intends to finish. */
  router.post('/cancel', guard, async (req, res) => {
    const { handle } = parse(CancelSchema, req.body);
    res.json({ cancelled: await service.logins.cancel(handle) });
  });

  return router;
}
