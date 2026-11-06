import type { FastifyInstance } from 'fastify';
import {
  GatewayError,
  gatewayErrorHttpStatus,
  microsoftOAuthSettings,
  type GatewayConfig,
} from '@yempik/core';
import type { Database } from '@yempik/database';
import { loadTokenKeyring } from '@yempik/security';
import type { AuditWriter } from '@yempik/observability';
import { createDrizzleOAuthStore, createMicrosoftOAuthService } from '@yempik/oauth';
import { createAdminBasicAuthHook } from './oauth.js';
import { renderPage } from './oauth-pages.js';

export interface MicrosoftOAuthRouteDependencies {
  config: GatewayConfig;
  database: Database;
  audit: AuditWriter;
}

export function registerMicrosoftOAuthRoutes(
  app: FastifyInstance,
  dependencies: MicrosoftOAuthRouteDependencies,
): boolean {
  const { config, database, audit } = dependencies;
  const settings = microsoftOAuthSettings(config);
  if (!settings) return false;

  const keyring = loadTokenKeyring(
    config.TOKEN_ENCRYPTION_KEYS,
    config.TOKEN_ENCRYPTION_CURRENT_VERSION,
  );
  const service = createMicrosoftOAuthService({
    tenantId: settings.tenantId,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    redirectUri: `${settings.publicBaseUrl}/oauth/microsoft/callback`,
    stateSecret: settings.stateSecret,
    keyring,
    store: createDrizzleOAuthStore(database),
  });
  const oauthRateLimit = { rateLimit: { max: 20, timeWindow: 60_000 } };

  app.get('/oauth/microsoft/start', {
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
          operation: 'oauth_microsoft_start',
          result: 'succeeded',
        });
        await reply.redirect(url, 302);
      } catch (error) {
        const gatewayError =
          error instanceof GatewayError
            ? error
            : new GatewayError('INTERNAL_ERROR', 'Unable to start the Microsoft OAuth flow', {
                retryable: false,
                correlationId,
                cause: error,
              });
        await audit.write({
          correlationId,
          mailboxId,
          operation: 'oauth_microsoft_start',
          result: 'failed',
          errorCode: gatewayError.code,
          metadata: { message: gatewayError.message },
        });
        await reply.code(gatewayErrorHttpStatus(gatewayError.code)).send(gatewayError.toJSON());
      }
    },
  });

  app.get('/oauth/microsoft/callback', {
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
          operation: 'oauth_microsoft_callback',
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
          operation: 'oauth_microsoft_callback',
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
            : new GatewayError('INTERNAL_ERROR', 'Unable to complete the Microsoft OAuth flow', {
                retryable: false,
                correlationId,
                cause: error,
              });
        await audit.write({
          correlationId,
          operation: 'oauth_microsoft_callback',
          result: 'failed',
          errorCode: gatewayError.code,
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
