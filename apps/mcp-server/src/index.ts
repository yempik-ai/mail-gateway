import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { googleOAuthSettings, loadGatewayConfig } from '@yempik/core';

// pnpm runs package scripts from the package directory: load the repo-root .env
// explicitly. Existing environment variables always win (dotenv never overrides).
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });
import { createDatabase } from '@yempik/database';
import { createAuditWriter, createLogger } from '@yempik/observability';
import { createProviderAdapterFactory } from './adapters.js';
import { buildServer } from './server.js';

export async function start(): Promise<void> {
  const config = loadGatewayConfig();
  const logger = createLogger({ level: config.LOG_LEVEL });
  const { db, pool } = createDatabase(config.DATABASE_URL);
  const adapterFactory = createProviderAdapterFactory(config, db);
  const app = await buildServer({
    config,
    database: db,
    audit: createAuditWriter(db),
    adapterFactory: adapterFactory,
    draftAdapterFactory: adapterFactory,
    logger,
    // Self-hosted behind a load balancer every client would otherwise share
    // the balancer's address, and one guesser could lock the operator out of
    // the admin login throttle.
    trustProxy: config.TRUST_PROXY,
  });

  const shutdown = async () => {
    await app.close();
    await pool.end();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    logger.info(
      {
        host: config.HOST,
        port: config.PORT,
        googleOAuth: googleOAuthSettings(config) ? 'enabled' : 'disabled',
      },
      'MCP server listening',
    );
  } catch (error) {
    logger.error({ error }, 'MCP server failed to start');
    await shutdown();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await start();
}

export * from './error-reporting.js';
export * from './server.js';
export * from './serverless.js';
