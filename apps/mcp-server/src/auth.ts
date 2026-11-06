import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { mcpClients, mcpOauthGrants, type Database } from '@yempik/database';
import { verifyClientSecret } from '@yempik/security';
import type { AuditWriter } from '@yempik/observability';
import type { GatewayConfig } from '@yempik/core';
import { sha256Base64Url } from './mcp-oauth.js';

export interface McpAuthContext {
  mcpClientId: string;
  correlationId: string;
}

export type AuthenticatedRequest = FastifyRequest & { mcpAuth?: McpAuthContext };

function parseBasicAuthorization(
  value: string | undefined,
): { id: string; secret: string } | undefined {
  if (!value?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 1) return undefined;
  return { id: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}

function credentialsFrom(request: FastifyRequest): { id: string; secret: string } | undefined {
  const basic = parseBasicAuthorization(request.headers.authorization);
  if (basic) return basic;
  const id = request.headers['x-mcp-client-id'];
  const secret = request.headers['x-mcp-client-secret'];
  return typeof id === 'string' && typeof secret === 'string' ? { id, secret } : undefined;
}

function bearerTokenFrom(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined;
}

export function createMcpAuthenticationMiddleware(
  database: Database,
  config: GatewayConfig,
  audit: AuditWriter,
) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const correlationId = request.id;

    if (config.GLOBAL_KILL_SWITCH) {
      await audit
        .write({ correlationId, operation: 'mcp_authentication', result: 'kill_switch' })
        .catch(() => undefined);
      await reply.code(503).send({ error: 'Gateway unavailable', correlationId });
      return;
    }

    let activeDatabaseSwitch: { active: boolean }[];
    try {
      activeDatabaseSwitch = await database
        .select({ active: sql<boolean>`coalesce(bool_or(${mcpClients.globalKillSwitch}), false)` })
        .from(mcpClients);
    } catch {
      await reply.code(503).send({ error: 'Gateway unavailable', correlationId });
      return;
    }
    if (activeDatabaseSwitch[0]?.active) {
      await audit.write({ correlationId, operation: 'mcp_authentication', result: 'kill_switch' });
      await reply.code(503).send({ error: 'Gateway unavailable', correlationId });
      return;
    }

    const unauthorized = async (reason: string) => {
      await audit.write({
        correlationId,
        operation: 'mcp_authentication',
        result: 'denied',
        metadata: { reason },
      });
      // Points OAuth-capable MCP clients (claude.ai) at the discovery metadata.
      reply.header(
        'www-authenticate',
        `Bearer resource_metadata="${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
      );
      await reply.code(401).send({ error: 'Authentication required', correlationId });
    };

    const bearer = bearerTokenFrom(request);
    if (bearer) {
      const rows = await database
        .select({ client: mcpClients })
        .from(mcpOauthGrants)
        .innerJoin(mcpClients, eq(mcpOauthGrants.mcpClientId, mcpClients.id))
        .where(
          and(
            eq(mcpOauthGrants.tokenHash, sha256Base64Url(bearer)),
            eq(mcpOauthGrants.kind, 'access'),
            isNull(mcpOauthGrants.consumedAt),
            gt(mcpOauthGrants.expiresAt, new Date()),
            eq(mcpClients.enabled, true),
            eq(mcpClients.allowlisted, true),
            eq(mcpClients.environment, config.NODE_ENV),
            isNull(mcpClients.revokedAt),
          ),
        )
        .limit(1);
      const client = rows[0]?.client;
      if (!client) {
        await unauthorized('invalid_bearer_token');
        return;
      }
      await database
        .update(mcpClients)
        .set({ lastAuthenticatedAt: new Date() })
        .where(eq(mcpClients.id, client.id));
      await audit.write({
        mcpClientId: client.id,
        correlationId,
        operation: 'mcp_authentication',
        result: 'succeeded',
        metadata: { method: 'bearer' },
      });
      (request as AuthenticatedRequest).mcpAuth = { mcpClientId: client.id, correlationId };
      return;
    }

    const credentials = credentialsFrom(request);
    if (!credentials || !config.MCP_CLIENT_ALLOWLIST.includes(credentials.id)) {
      await unauthorized(credentials ? 'not_allowlisted' : 'missing_credentials');
      return;
    }

    const rows = await database
      .select()
      .from(mcpClients)
      .where(
        and(
          eq(mcpClients.id, credentials.id),
          eq(mcpClients.enabled, true),
          eq(mcpClients.allowlisted, true),
          eq(mcpClients.environment, config.NODE_ENV),
          isNull(mcpClients.revokedAt),
        ),
      )
      .limit(1);
    const client = rows[0];
    const valid = client ? await verifyClientSecret(credentials.secret, client.secretHash) : false;

    if (!client || !valid) {
      await unauthorized(client ? 'secret_mismatch' : 'client_not_found');
      return;
    }

    await database
      .update(mcpClients)
      .set({ lastAuthenticatedAt: new Date() })
      .where(eq(mcpClients.id, client.id));
    await audit.write({
      mcpClientId: client.id,
      correlationId,
      operation: 'mcp_authentication',
      result: 'succeeded',
    });
    (request as AuthenticatedRequest).mcpAuth = { mcpClientId: client.id, correlationId };
  };
}
