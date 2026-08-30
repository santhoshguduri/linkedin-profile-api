/**
 * Express application wiring.
 *
 * This is an API server only -- the React client is a separate deployment on a
 * separate origin, which is why CORS is real configuration here rather than a
 * formality.
 */
import express, { type Express } from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { probeChromium } from './linkedin/renderer.js';
import { AppError } from './util/errors.js';
import { ProfileService } from './service.js';
import { requireApiKey } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { profileRouter } from './routes/profile.js';
import { systemRouter } from './routes/system.js';

export const VERSION = '1.0.0';

export interface App {
  app: Express;
  service: ProfileService;
}

export function createApp(config: Config, log: Logger): App {
  const app = express();
  const service = new ProfileService(config, log);

  // Started, not awaited. It settles in milliseconds and only feeds the status
  // getter, so blocking app construction on it would buy nothing.
  if (config.BROWSER_LOGIN) {
    void probeChromium().then((present) => {
      if (!present) {
        log.warn(
          'BROWSER_LOGIN is on but no Chromium binary was found, so password sign-in is switched off and /api/status reports it unavailable. Profile lookups still need a browser: set LI_AT and RENDER_PROFILES=false for a top-card-only deployment, or run the Docker image, which ships one.',
        );
      }
    });
  }

  app.disable('x-powered-by');
  /**
   * One hop. Render and most PaaS front ends terminate TLS and append the client
   * IP to X-Forwarded-For; `true` would trust the entire chain, letting a caller
   * spoof its own IP straight past the rate limiter.
   */
  app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger: log,
      // Platform health checks would otherwise dominate the log.
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  app.use(
    cors({
      origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',').map((o) => o.trim()),
      methods: ['GET', 'POST'],
      allowedHeaders: [
      'content-type',
      'x-api-key',
      'authorization',
      'x-li-at',
      'x-li-jsessionid',
      'x-li-cookie',
      'x-li-username',
      'x-li-password',
    ],
      maxAge: 86_400,
    }),
  );

  app.use(express.json({ limit: '32kb' }));

  /**
   * Inbound limit, independent of the outbound LinkedIn budget: this one
   * protects the process, the token bucket in the fetcher protects the LinkedIn
   * session. Scoped to /api so it is not spent on health checks.
   */
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: config.INBOUND_RPM,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next, options) => {
        next(
          new AppError('RATE_LIMITED', `Too many requests. Limit is ${options.limit} per minute.`, {
            retryAfterSeconds: Math.ceil(options.windowMs / 1000),
          }),
        );
      },
    }),
  );

  app.use(systemRouter(service, VERSION));

  /**
   * Sign-in is limited far harder than lookups, and by IP rather than by key.
   * Each attempt drives a real browser against LinkedIn's login, so a loose
   * limit here is both a brute-force channel and the fastest way to get the
   * host's IP flagged. Ten a minute is generous for a human and useless to a
   * script.
   */
  app.use(
    '/api/auth',
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next) => {
        next(
          new AppError('RATE_LIMITED', 'Too many sign-in attempts. Wait a minute and try again.', {
            retryAfterSeconds: 60,
          }),
        );
      },
    }),
    requireApiKey(config),
    authRouter(service, config),
  );

  app.use('/api/profile', requireApiKey(config), profileRouter(service, config));

  app.use(notFound);
  app.use(errorHandler);

  return { app, service };
}
