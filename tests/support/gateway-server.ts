// Builds the real Fastify app (buildServer) over a stub database, capturing
// the structured logs and the error reports, for tests of the HTTP surface.

import { Writable } from 'node:stream';
import { afterEach } from 'vitest';
import { loadGatewayConfig } from '../../packages/core/src/index.js';
import type { Database } from '../../packages/database/src/index.js';
import { createLogger, type AuditWriter } from '../../packages/observability/src/index.js';
import type { SQL } from '../../apps/mcp-server/node_modules/drizzle-orm/index.js';
import { PgDialect } from '../../apps/mcp-server/node_modules/drizzle-orm/pg-core/index.js';
import { buildServer, type ServerDependencies } from '../../apps/mcp-server/src/server.js';
import type { ErrorReporter } from '../../apps/mcp-server/src/error-reporting.js';

export const PUBLIC_BASE_URL = 'https://mail.example.test';
export const STRONG_ADMIN_SECRET = 'admin-secret-longer-than-sixteen';

const BASE_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  // Port 1 refuses at once: the dashboard's migration box degrades instead of hanging.
  DATABASE_URL: 'postgresql://stub:stub@127.0.0.1:1/stub',
  MCP_CLIENT_ID: 'test-client',
  MCP_CLIENT_SECRET: 'test-client-secret-0123456789',
  MCP_CLIENT_ALLOWLIST: 'test-client',
  TOKEN_ENCRYPTION_CURRENT_VERSION: '1',
  TOKEN_ENCRYPTION_KEYS: '{"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
  PUBLIC_BASE_URL,
  ADMIN_DASHBOARD_SECRET: STRONG_ADMIN_SECRET,
  OAUTH_STATE_SECRET: 'oauth-state-secret-0123456789',
  GOOGLE_OAUTH_CLIENT_ID: 'google-client',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
};

export function basicAuthorization(password: string): string {
  return `Basic ${Buffer.from(`admin:${password}`, 'utf8').toString('base64')}`;
}

/** Every statement succeeds with no rows; the kill-switch read reports inactive. */
export function createDatabaseStub(options: { failing?: boolean } = {}): Database {
  const dialect = new PgDialect();
  return {
    execute(query: SQL) {
      if (options.failing) return Promise.reject(new Error('connection refused'));
      const statement = dialect.sqlToQuery(query).sql;
      return Promise.resolve({ rows: statement.includes('bool_or') ? [{ active: false }] : [] });
    },
  } as unknown as Database;
}

const audit: AuditWriter = { write: () => Promise.resolve() };

export type GatewayApp = Awaited<ReturnType<typeof buildServer>>;

export interface GatewayHarness {
  app: GatewayApp;
  logs: () => Record<string, unknown>[];
  reports: { error: unknown; correlationId: string }[];
}

const openApps: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** Closes `app` after the current test. */
export function closeAfterTest(app: { close(): Promise<unknown> }): void {
  openApps.push(app);
}

export async function buildGatewayHarness(
  overrides: {
    env?: Record<string, string>;
    dependencies?: Partial<ServerDependencies>;
  } = {},
): Promise<GatewayHarness> {
  let emitted = '';
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      emitted += chunk.toString();
      callback();
    },
  });
  const reports: GatewayHarness['reports'] = [];
  const errorReporter: ErrorReporter = {
    capture(error, correlationId) {
      reports.push({ error, correlationId });
    },
    flush: () => Promise.resolve(),
  };
  const app = await buildServer({
    config: loadGatewayConfig({ ...BASE_ENV, ...overrides.env }),
    database: createDatabaseStub(),
    audit,
    logger: createLogger({ level: 'info', destination }),
    errorReporter,
    ...overrides.dependencies,
  });
  closeAfterTest(app);
  return {
    app,
    reports,
    logs: () =>
      emitted
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
