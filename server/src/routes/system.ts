/** Service index, liveness and operational counters. */
import { Router } from 'express';
import type { ProfileService } from '../service.js';

export function systemRouter(service: ProfileService, version: string): Router {
  const router = Router();

  // A self-describing root beats a 404 for anyone who opens the API host in a
  // browser, and it keeps the endpoint list in the code rather than only in the
  // README.
  router.get('/', (_req, res) => {
    res.json({
      name: 'linkedin-profile-api',
      version,
      endpoints: {
        'GET /api/profile?url=': 'Extract a profile. Add &refresh=true to bypass the cache.',
        'POST /api/profile': 'Same, with { url, refresh } in a JSON body.',
        'POST /api/auth/login': 'Sign in with a LinkedIn email and password.',
        'POST /api/auth/verify':
          'Finish a sign-in: poll the approval sent to the LinkedIn app, or submit a code.',
        'POST /api/auth/cancel': 'Abandon a sign-in that is waiting on verification.',
        'GET /api/status': 'Cache, rate limit and session state.',
        'GET /health': 'Liveness probe.',
      },
    });
  });

  // Deliberately dependency-free: a throttled LinkedIn session must not cause
  // the platform to restart an otherwise healthy process.
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', version, uptimeSeconds: Math.floor(process.uptime()) });
  });

  // Readiness plus counters. Reports whether a credential is configured, never
  // the credential itself. Unauthenticated so the web UI can show status before
  // a key is entered.
  router.get('/api/status', (_req, res) => {
    res.json({ status: 'ok', version, ...service.stats });
  });

  return router;
}
