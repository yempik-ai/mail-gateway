import { STATUS_CODES } from 'node:http';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { GatewayConfig } from '@yempik/core';
import type { Database } from '@yempik/database';
import type { AuditWriter } from '@yempik/observability';
import { createCorrelationId, createLogger } from '@yempik/observability';
import formbody from '@fastify/formbody';
import { adminThrottleKey } from './admin-auth-throttle.js';
import { registerAdminDashboard } from './admin-dashboard.js';
import {
  ADMIN_SECRET_MIN_LENGTH,
  FORWARDED_FOR_IGNORED_LOG,
  forwardedForIgnored,
  isTrustProxyOff,
  isWeakAdminSecret,
} from './admin-warnings.js';
import { createMcpAuthenticationMiddleware, type AuthenticatedRequest } from './auth.js';
import { createErrorReporter, type ErrorReporter } from './error-reporting.js';
import { registerHttpSecurity } from './http-security.js';
import { registerMcpOAuthRoutes, type McpOAuthStore } from './mcp-oauth.js';
import { registerMicrosoftOAuthRoutes } from './microsoft-oauth.js';
import { registerGoogleOAuthRoutes } from './oauth.js';
import { registerZohoOAuthRoutes } from './zoho-oauth.js';
import type { AdapterFactory } from './mail-search.js';
import type { DraftAdapterFactory } from './draft-service.js';
import { adapterWiring, createMcpServer, gatewayHealth } from './tools.js';

export interface ServerDependencies {
  config: GatewayConfig;
  database: Database;
  audit: AuditWriter;
  /** Provider adapters for the read tools; without them those tools report UNSUPPORTED_OPERATION. */
  adapterFactory?: AdapterFactory;
  /** Provider adapters for the draft tools; without them those tools report UNSUPPORTED_OPERATION. */
  draftAdapterFactory?: DraftAdapterFactory;
  /** MCP OAuth clients and grants; defaults to the Drizzle store over `database`. */
  mcpOAuthStore?: McpOAuthStore;
  /** Defaults to the redacting project logger at LOG_LEVEL. */
  logger?: ReturnType<typeof createLogger>;
  /** Defaults to Sentry when SENTRY_DSN is set; null disables reporting. */
  errorReporter?: ErrorReporter | null;
  /**
   * Wait for the error report to be delivered before answering a 500. Set by
   * the serverless entry, whose instance freezes after the response; a
   * long-lived process (the default) delivers in the background instead.
   */
  flushOnError?: boolean;
  /**
   * Which hops may set the client address through X-Forwarded-For; defaults
   * to TRUST_PROXY. Only behind a proxy that overwrites the header (Vercel
   * does), or clients could pick their own IP and escape the per-IP limits.
   */
  trustProxy?: GatewayConfig['TRUST_PROXY'];
}

/**
 * Fastify 5 treats a numeric trustProxy as "trust nothing" (it cannot check
 * the immediate peer), so a hop count becomes the classic Express rule: the
 * nearest `hops` addresses are proxies. That is only safe when the gateway is
 * reachable through those proxies alone, which is what TRUST_PROXY=<n> states.
 */
function fastifyTrustProxy(
  trustProxy: GatewayConfig['TRUST_PROXY'],
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof trustProxy !== 'number') return trustProxy;
  const hops = trustProxy;
  return (_address, hop) => hop < hops;
}

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const { config, database, audit, adapterFactory, draftAdapterFactory } = dependencies;
  // Widened to Fastify's logger interface so the instance keeps the default
  // FastifyInstance type that route modules are written against.
  const logger: FastifyBaseLogger =
    dependencies.logger ?? createLogger({ level: config.LOG_LEVEL });
  const trustProxy = dependencies.trustProxy ?? config.TRUST_PROXY;
  const app = Fastify({
    loggerInstance: logger,
    // Per-request access logs would carry URLs with OAuth codes and mailbox
    // identifiers; audit_events is the request record instead.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: fastifyTrustProxy(trustProxy),
    genReqId(request) {
      const incoming = request.headers['x-correlation-id'];
      return createCorrelationId(typeof incoming === 'string' ? incoming : undefined);
    },
  });
  // A reporter that cannot start must not take the gateway down with it.
  const errorReporter =
    dependencies.errorReporter === undefined
      ? await createErrorReporter({
          dsn: config.SENTRY_DSN,
          environment: config.NODE_ENV,
        }).catch((error: unknown) => {
          app.log.error(
            { message: error instanceof Error ? error.message : String(error) },
            'error reporting disabled: Sentry failed to initialise',
          );
          return undefined;
        })
      : (dependencies.errorReporter ?? undefined);

  // First, so its hooks cover every route and the not-found handler below.
  registerHttpSecurity(app, { publicBaseUrl: config.PUBLIC_BASE_URL });

  // Behind a balancer with TRUST_PROXY off, every client shares the
  // balancer's address: one guesser locks the operator out of the admin
  // login, and the rate limits treat all clients as one. Said once, on the
  // first forwarded request: a process runs one server, and repeating it per
  // request would drown the log.
  if (isTrustProxyOff(trustProxy)) {
    let forwardedForWarned = false;
    app.addHook('onRequest', (request, _reply, done) => {
      if (!forwardedForWarned && forwardedForIgnored(request, trustProxy)) {
        forwardedForWarned = true;
        app.log.warn(
          { setting: 'TRUST_PROXY', header: 'x-forwarded-for' },
          FORWARDED_FOR_IGNORED_LOG,
        );
      }
      done();
    });
  }

  // Client errors (validation, malformed JSON, rate limits) keep Fastify's
  // descriptive shape; anything else is a bug whose details stay server-side.
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        statusCode,
        ...(error.code === undefined ? {} : { code: error.code }),
        error: STATUS_CODES[statusCode],
        message: error.message,
      });
    }
    // Route pattern, not request.url: query strings carry OAuth codes.
    request.log.error(
      {
        correlationId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        err: { type: error.name, code: error.code, message: error.message, stack: error.stack },
      },
      'unhandled error',
    );
    if (errorReporter) {
      try {
        errorReporter.capture(error, request.id);
        // Only where the instance freezes after the response; a long-lived
        // process must not hold every 500 for up to the flush timeout.
        if (dependencies.flushOnError) await errorReporter.flush();
      } catch (reportError) {
        request.log.warn(
          { correlationId: request.id, message: String(reportError) },
          'error report not delivered',
        );
      }
    }
    return reply.code(500).send({ code: 'INTERNAL_ERROR', correlationId: request.id });
  });
  app.setNotFoundHandler(async (request, reply) =>
    reply
      .code(404)
      .send({ code: 'NOT_FOUND', message: 'Route not found', correlationId: request.id }),
  );

  if (config.ADMIN_DASHBOARD_SECRET && isWeakAdminSecret(config.ADMIN_DASHBOARD_SECRET)) {
    // Not fatal on purpose: refusing to boot would take production down over
    // a password that is weak, not leaked. The dashboard shows the same warning.
    app.log.warn(
      { setting: 'ADMIN_DASHBOARD_SECRET', minimumLength: ADMIN_SECRET_MIN_LENGTH },
      'admin password is shorter than 16 characters',
    );
  }

  // Keyed by client network, the same key as the admin login throttle. The
  // limit runs before authentication, so a client-chosen header (such as
  // x-mcp-client-id) would let one source rotate it for a fresh budget per
  // request. request.ip honours TRUST_PROXY, and an IPv6 client is its /64
  // because one subscriber gets the whole block.
  await app.register(rateLimit, {
    global: false,
    max: config.MCP_RATE_LIMIT_MAX,
    timeWindow: config.MCP_RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => adminThrottleKey(request.ip),
  });

  await app.register(formbody);

  // Provider settings without an adapter factory (tests, foundation boots)
  // still mean no provider can be reached.
  const adapters = adapterWiring(adapterFactory === undefined ? undefined : config);

  if (config.ADMIN_DASHBOARD_SECRET) {
    registerMcpOAuthRoutes(app, {
      config,
      database,
      audit,
      adminSecret: config.ADMIN_DASHBOARD_SECRET,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      ...(dependencies.mcpOAuthStore === undefined ? {} : { store: dependencies.mcpOAuthStore }),
    });
  }
  registerGoogleOAuthRoutes(app, { config, database, audit });
  registerMicrosoftOAuthRoutes(app, { config, database, audit });
  registerZohoOAuthRoutes(app, { config, database, audit });
  if (config.ADMIN_DASHBOARD_SECRET) {
    registerAdminDashboard(app, {
      config,
      database,
      audit,
      adminSecret: config.ADMIN_DASHBOARD_SECRET,
      trustProxy,
      ...(adapterFactory === undefined ? {} : { adapterFactory }),
    });
  }

  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const health = await gatewayHealth(database, adapters);
    return health.status === 'ok' ? health : reply.code(503).send(health);
  });

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    config: {
      rateLimit: { max: config.MCP_RATE_LIMIT_MAX, timeWindow: config.MCP_RATE_LIMIT_WINDOW_MS },
    },
    preHandler: createMcpAuthenticationMiddleware(database, config, audit),
    async handler(request, reply) {
      const auth = (request as AuthenticatedRequest).mcpAuth;
      if (!auth) return;

      const server = createMcpServer(database, audit, auth, {
        ...(adapterFactory === undefined ? {} : { adapterFactory }),
        ...(draftAdapterFactory === undefined ? {} : { draftAdapterFactory }),
        quoteTimeZone: config.GATEWAY_TIME_ZONE,
        adapters,
      });
      // Stateless mode: omitting sessionIdGenerator disables session tracking.
      const transport = new StreamableHTTPServerTransport({});
      // The SDK is compiled without exactOptionalPropertyTypes, so its own
      // transport class does not satisfy its Transport interface under our flags.
      await server.connect(transport as unknown as Transport);
      reply.hijack();
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } finally {
        await transport.close();
        await server.close();
      }
    },
  });

  return app;
}
