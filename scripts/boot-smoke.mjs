// Boots the built serverless app the way Vercel does and hits the routes that
// need no database. Run it with `node --no-experimental-require-module` (see
// the root `smoke` script): Vercel's function loader cannot `require()` an ES
// module, so a CommonJS dependency that pulls in an ESM-only package crashes
// every invocation there while passing under a plain Node 22, where
// require(esm) is enabled. Reproducing that loader locally keeps such a
// dependency change from reaching production again.

const placeholders = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://smoke:smoke@127.0.0.1:5432/smoke',
  MCP_CLIENT_ID: 'smoke-client',
  MCP_CLIENT_SECRET: 'smoke-secret-0123456789',
  MCP_CLIENT_ALLOWLIST: 'smoke-client',
  TOKEN_ENCRYPTION_CURRENT_VERSION: '1',
  TOKEN_ENCRYPTION_KEYS: '{"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
  ADMIN_DASHBOARD_SECRET: 'smoke-admin-password-0123',
  // Never contacted: no event is captured. Set so the lazily imported
  // @sentry/node goes through the same loader as the rest of the app.
  SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
  LOG_LEVEL: 'warn',
};
for (const [key, value] of Object.entries(placeholders)) process.env[key] ??= value;

// Import by package name, exactly as api/index.ts does on Vercel: a path
// import would succeed even when node_modules/@yempik/mcp-server resolves to
// a copy without dist/, which is how deployment 3b82f18 failed in production.
const { buildServerlessApp, createErrorReporter } = await import('@yempik/mcp-server');

// The app logs and carries on when Sentry fails to start, so the loader
// problem would go unnoticed through the app alone: load it directly.
const reporter = await createErrorReporter({ dsn: process.env.SENTRY_DSN, environment: 'smoke' });
if (!reporter) throw new Error('Sentry error reporter did not initialise');

const app = await buildServerlessApp();
try {
  const live = await app.inject({ method: 'GET', url: '/health/live' });
  if (live.statusCode !== 200) throw new Error(`/health/live returned ${live.statusCode}`);
  const admin = await app.inject({ method: 'GET', url: '/admin' });
  if (admin.statusCode !== 401)
    throw new Error(`/admin returned ${admin.statusCode}, expected 401`);
  if (admin.headers['x-frame-options'] !== 'DENY')
    throw new Error('/admin is missing X-Frame-Options: DENY');
  console.log('boot smoke: ok (/health/live 200, /admin 401 with security headers, Sentry loaded)');
} finally {
  await app.close();
}
