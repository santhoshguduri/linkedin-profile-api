/**
 * Serverless entrypoint, for hosts that invoke a handler instead of running a
 * process. `src/index.ts` is the other half of the pair: it owns the socket and
 * the shutdown signals, neither of which exists here.
 *
 * Vercel's Node runtime requires the module's default export to be a function it
 * can call with (req, res). `createApp` returns `{ app, service }` so that a
 * long-lived process can close the service on SIGTERM, and handing that object
 * over produced "Invalid export found in module ... The default export must be a
 * function or server". An Express app *is* such a function, so this unwraps it.
 *
 * Built once per cold start and reused across invocations on the same instance,
 * because module scope is the only thing a serverless host keeps between calls.
 *
 * Read `vercel.json` next to this file before relying on it: a profile lookup
 * needs Chromium, and a serverless bundle has none.
 */
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/util/logger.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, !config.isProduction);
const { app } = createApp(config, log);

export default app;
