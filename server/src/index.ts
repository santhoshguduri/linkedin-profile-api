/**
 * Process entrypoint: load config, listen, shut down cleanly.
 *
 * The server starts even without LinkedIn credentials. That is deliberate --
 * /health and /api/status still work and profile lookups return a typed
 * NOT_CONFIGURED, so a misconfigured deploy is diagnosable over HTTP rather than
 * only in platform logs.
 */
import { loadConfig } from './config.js';
import { createApp, VERSION } from './app.js';
import { createLogger } from './util/logger.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, !config.isProduction);
const { app, service } = createApp(config, log);

const server = app.listen(config.PORT, config.HOST, () => {
  log.info(
    {
      version: VERSION,
      port: config.PORT,
      authMode: config.authMode,
      authEnabled: config.authEnabled,
      proxy: config.PROXY_URL ? 'configured' : 'none',
      outboundRpm: config.OUTBOUND_RPM,
    },
    'linkedin-profile-api ready',
  );

  if (!config.hasCredentials) {
    log.warn(
      'No LinkedIn session configured. This server has no identity of its own, so its own lookups return NOT_CONFIGURED; callers can still sign in at POST /api/auth/login or send a cookie per request while ALLOW_REQUEST_CREDENTIALS is on. Set LI_AT, or LI_USERNAME and LI_PASSWORD, to change that.',
    );
  }
});

/**
 * Stop accepting connections, let in-flight requests drain, then release the
 * undici pool. The timer is the backstop for a hung upstream request holding a
 * socket open past the platform's own kill deadline.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000).unref();

  server.close(async () => {
    clearTimeout(force);
    await service.close();
    process.exit(0);
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, (s) => void shutdown(s));
}
