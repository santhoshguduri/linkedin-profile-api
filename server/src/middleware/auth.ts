/**
 * API-key gate.
 *
 * The key protects this deployment's LinkedIn session from being spent by
 * strangers -- it is a quota control, not an identity system. With API_KEY unset
 * the API is open, which is right for a local run and a documented risk for a
 * public one.
 */
import type { RequestHandler } from 'express';
import { AppError } from '../util/errors.js';
import type { Config } from '../config.js';

export function requireApiKey(config: Config): RequestHandler {
  if (!config.authEnabled) return (_req, _res, next) => next();

  return (req, _res, next) => {
    const header = req.get('x-api-key') ?? req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (header !== config.API_KEY) {
      next(new AppError('UNAUTHORIZED', 'Missing or invalid API key.'));
      return;
    }
    next();
  };
}
