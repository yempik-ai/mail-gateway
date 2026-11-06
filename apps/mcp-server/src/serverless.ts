import { loadGatewayConfig } from '@yempik/core';
import { createDatabase } from '@yempik/database';
import { createAuditWriter } from '@yempik/observability';
import { createProviderAdapterFactory } from './adapters.js';
import { buildServer } from './server.js';
import type { FastifyInstance } from 'fastify';

/**
 * Bootstrap for serverless runtimes (Vercel): configuration from real
 * environment variables, one small pool per warm worker, no listen().
 */
export async function buildServerlessApp(): Promise<FastifyInstance> {
  const config = loadGatewayConfig();
  const { db } = createDatabase(config.DATABASE_URL, { max: 1 });
  const adapterFactory = createProviderAdapterFactory(config, db);
  const app = await buildServer({
    config,
    database: db,
    audit: createAuditWriter(db),
    adapterFactory: adapterFactory,
    draftAdapterFactory: adapterFactory,
    // Vercel's edge overwrites X-Forwarded-For with the real client address,
    // so it is safe to key the per-IP limits on it; the socket peer is Vercel.
    trustProxy: true,
    // The instance freezes once the response is sent, with any report still
    // queued in it.
    flushOnError: true,
  });
  await app.ready();
  return app;
}
