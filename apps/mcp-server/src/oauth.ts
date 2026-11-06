import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  GatewayError,
  gatewayErrorHttpStatus,
  googleOAuthSettings,
  type GatewayConfig,
} from '@yempik/core';
import type { Database } from '@yempik/database';
import { loadTokenKeyring } from '@yempik/security';
import type { AuditWriter } from '@yempik/observability';
import { createDrizzleOAuthStore, createGoogleOAuthService } from '@yempik/oauth';
import {
  adminThrottleKey,
  createAdminAuthThrottle,
  type AdminAuthThrottle,
} from './admin-auth-throttle.js';
import { renderPage } from './oauth-pages.js';

export interface OAuthRouteDependencies {
  config: GatewayConfig;
  database: Database;
  audit: AuditWriter;
}

function constantTimeEquals(provided: string, expected: string): boolean {
  // Hashing first makes the comparison length-independent.
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

// One throttle per Fastify instance, shared by every admin-guarded route, so
// the budget is per client rather than per route. A request built without a
// server (unit tests) shares a process-wide one.
const throttles = new WeakMap<object, AdminAuthThrottle>();
const detachedThrottle = createAdminAuthThrottle();

function throttleFor(request: FastifyRequest): AdminAuthThrottle {
  const server = (request as Partial<FastifyRequest>).server;
  if (!server) return detachedThrottle;
  let throttle = throttles.get(server);
  if (!throttle) {
    throttle = createAdminAuthThrottle();
    throttles.set(server, throttle);
  }
  return throttle;
}

export interface AdminBasicAuthOptions {
  /** Overrides the per-instance throttle; tests use it to start from a clean budget. */
  throttle?: AdminAuthThrottle;
}

/**
 * HTTP Basic guard for the admin connect flow: any username, password equal to
 * ADMIN_DASHBOARD_SECRET. Browser-native, no session state to manage.
 * Only a presented wrong password counts as a failure: the browser's first,
 * credential-less request that triggers the login prompt does not.
 */
export function createAdminBasicAuthHook(adminSecret: string, options: AdminBasicAuthOptions = {}) {
  return async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const throttle = options.throttle ?? throttleFor(request);
    const clientKey = adminThrottleKey((request as Partial<FastifyRequest>).ip ?? 'unknown');
    const retryAfter = throttle.retryAfterSeconds(clientKey);
    if (retryAfter !== undefined) {
      reply.header('retry-after', String(retryAfter));
      await reply
        .code(429)
        .send({ error: 'Too many failed administrator authentications', retryAfter });
      return;
    }

    const header = request.headers.authorization;
    let providedSecret: string | undefined;
    if (typeof header === 'string' && header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) providedSecret = decoded.slice(separator + 1);
    }
    if (!providedSecret || !constantTimeEquals(providedSecret, adminSecret)) {
      if (providedSecret) {
        // Not counted only while every tracked client is blocked: a guessing
        // flood from many networks, which the operator should hear about.
        const counted = throttle.recordFailure(clientKey);
        (request as Partial<FastifyRequest>).log?.warn(
          { correlationId: request.id, counted },
          counted
            ? 'admin authentication failed'
            : 'admin authentication failed, not counted: every client the throttle tracks is blocked',
        );
      }
      reply.header('www-authenticate', 'Basic realm="yempik-mail-gateway admin"');
      await reply.code(401).send({ error: 'Administrator authentication required' });
      return;
    }
    throttle.reset(clientKey);
  };
}

export function registerGoogleOAuthRoutes(
  app: FastifyInstance,
  dependencies: OAuthRouteDependencies,
): boolean {
  const { config, database, audit } = dependencies;
  const settings = googleOAuthSettings(config);
  if (!settings) return false;

  const keyring = loadTokenKeyring(
    config.TOKEN_ENCRYPTION_KEYS,
    config.TOKEN_ENCRYPTION_CURRENT_VERSION,
  );
  const service = createGoogleOAuthService({
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    redirectUri: `${settings.publicBaseUrl}/oauth/google/callback`,
    stateSecret: settings.stateSecret,
    keyring,
    store: createDrizzleOAuthStore(database),
  });
  const oauthRateLimit = { rateLimit: { max: 20, timeWindow: 60_000 } };

  app.get('/oauth/google/start', {
    config: oauthRateLimit,
    preHandler: createAdminBasicAuthHook(settings.adminSecret),
    async handler(request, reply) {
      const correlationId = request.id;
      const query = request.query as Record<string, unknown>;
      const mailboxId = typeof query.mailboxId === 'string' ? query.mailboxId : undefined;
      if (!mailboxId) {
        await reply.code(400).send({ error: 'mailboxId query parameter is required' });
        return;
      }
      try {
        const url = await service.authorizationUrl(mailboxId, correlationId);
        await audit.write({
          correlationId,
          mailboxId,
          operation: 'oauth_google_start',
          result: 'succeeded',
        });
        await reply.redirect(url, 302);
      } catch (error) {
        const gatewayError =
          error instanceof GatewayError
            ? error
            : new GatewayError('INTERNAL_ERROR', 'Unable to start the Google OAuth flow', {
                retryable: false,
                correlationId,
                cause: error,
              });
        await audit.write({
          correlationId,
          mailboxId,
          operation: 'oauth_google_start',
          result: 'failed',
          errorCode: gatewayError.code,
          metadata: { message: gatewayError.message },
        });
        await reply.code(gatewayErrorHttpStatus(gatewayError.code)).send(gatewayError.toJSON());
      }
    },
  });

  app.get('/oauth/google/callback', {
    config: oauthRateLimit,
    async handler(request, reply) {
      const correlationId = request.id;
      const query = request.query as Record<string, unknown>;
      const code = typeof query.code === 'string' ? query.code : undefined;
      const state = typeof query.state === 'string' ? query.state : undefined;
      const providerError = typeof query.error === 'string' ? query.error : undefined;

      if (providerError || !code || !state) {
        await audit.write({
          correlationId,
          operation: 'oauth_google_callback',
          result: 'failed',
          errorCode: 'AUTH_REQUIRED',
          metadata: providerError ? { providerError } : {},
        });
        await reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send(
            renderPage(
              'Connection not completed',
              providerError === 'access_denied'
                ? 'You cancelled the authorization. Start again from the admin dashboard.'
                : `The authorization response is invalid. Correlation ID: ${correlationId}`,
            ),
          );
        return;
      }

      try {
        const result = await service.handleCallback({ code, state }, correlationId);
        await audit.write({
          correlationId,
          mailboxId: result.mailboxId,
          operation: 'oauth_google_callback',
          result: 'succeeded',
        });
        await reply
          .type('text/html; charset=utf-8')
          .send(
            renderPage(
              'Mailbox connected',
              `${result.emailAddress} is now connected as ${result.mailboxId}. You can close this window.`,
            ),
          );
      } catch (error) {
        const gatewayError =
          error instanceof GatewayError
            ? error
            : new GatewayError('INTERNAL_ERROR', 'Unable to complete the Google OAuth flow', {
                retryable: false,
                correlationId,
                cause: error,
              });
        await audit.write({
          correlationId,
          operation: 'oauth_google_callback',
          result: 'failed',
          errorCode: gatewayError.code,
          metadata: { message: gatewayError.message },
        });
        await reply
          .code(gatewayErrorHttpStatus(gatewayError.code))
          .type('text/html; charset=utf-8')
          .send(
            renderPage(
              'Connection failed',
              `Error ${gatewayError.code}. Correlation ID: ${correlationId}`,
            ),
          );
      }
    },
  });

  return true;
}
