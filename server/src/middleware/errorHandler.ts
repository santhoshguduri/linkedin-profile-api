/**
 * The one place a failure becomes an HTTP response.
 *
 * Every error leaves the API in the same envelope, so a client can always read
 * `error.code` and never has to parse a message:
 *
 *   { "error": { "code": "SESSION_INVALID", "message": "...", "hint": "..." } }
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../util/errors.js';

/** Body-parser failures arrive as plain Errors with a `type` discriminator. */
const BODY_ERRORS: Record<string, { code: 'BAD_REQUEST'; message: string }> = {
  'entity.parse.failed': { code: 'BAD_REQUEST', message: 'Request body is not valid JSON.' },
  'entity.too.large': { code: 'BAD_REQUEST', message: 'Request body is too large.' },
};

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  // Express requires delegating to the default handler once the response has
  // started: a second set of headers cannot be sent.
  if (res.headersSent) return next(error);

  const type = (error as { type?: string }).type;
  const known =
    error instanceof AppError
      ? error
      : type && BODY_ERRORS[type]
        ? new AppError(BODY_ERRORS[type].code, BODY_ERRORS[type].message)
        : null;

  if (!known) {
    // Unexpected: log the whole thing, tell the client nothing. Stack traces and
    // upstream response bodies must never reach a caller.
    req.log.error({ err: error }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
    return;
  }

  if (known.statusCode >= 500) req.log.error({ err: known }, 'request failed');
  else req.log.warn({ code: known.code, msg: known.message }, 'request rejected');

  if (known.retryAfterSeconds) res.set('retry-after', String(known.retryAfterSeconds));
  res.status(known.statusCode).json(known.toJSON());
};
