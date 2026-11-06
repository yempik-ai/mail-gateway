import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { isAllowlistedMcpOAuthRedirect, type GatewayConfig } from '@yempik/core';
import { mcpClients, mcpOauthGrants, type Database } from '@yempik/database';
import { hashClientSecret, verifyClientSecret } from '@yempik/security';
import type { AuditWriter } from '@yempik/observability';
import { htmlContentSecurityPolicy } from './http-security.js';
import { createAdminBasicAuthHook } from './oauth.js';
import { renderConsentPage } from './oauth-pages.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/** RFC 7636 S256: base64url(sha256(verifier)) must equal the stored challenge. */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const actual = Buffer.from(sha256Base64Url(codeVerifier));
  const expected = Buffer.from(codeChallenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface McpOAuthClientRecord {
  id: string;
  displayName: string;
  secretHash: string;
}

export type McpOAuthGrantKind = 'code' | 'access' | 'refresh';

export interface NewMcpOAuthGrant {
  mcpClientId: string;
  kind: McpOAuthGrantKind;
  tokenHash: string;
  codeChallenge?: string;
  redirectUri?: string;
  expiresAt: Date;
}

export interface McpOAuthGrantRecord {
  id: string;
  mcpClientId: string;
  codeChallenge: string | null;
  redirectUri: string | null;
}

/** Persistence of the MCP authorization server: clients and hashed grants. */
export interface McpOAuthStore {
  /** Enabled, allowlisted, unrevoked client of this environment. */
  findActiveClient(clientId: string): Promise<McpOAuthClientRecord | undefined>;
  registerClient(client: McpOAuthClientRecord): Promise<void>;
  insertGrants(grants: NewMcpOAuthGrant[]): Promise<void>;
  /** Unconsumed, unexpired grant of `kind` whose token hashes to `tokenHash`. */
  findUsableGrant(
    tokenHash: string,
    kind: 'code' | 'refresh',
    now: Date,
  ): Promise<McpOAuthGrantRecord | undefined>;
  /**
   * Marks the grant used. Conditional on it still being unused, so two
   * concurrent exchanges of one code or refresh token cannot both succeed:
   * false means another request consumed it first.
   */
  consumeGrant(grantId: string, now: Date): Promise<boolean>;
}

export function createDrizzleMcpOAuthStore(
  database: Database,
  environment: GatewayConfig['NODE_ENV'],
): McpOAuthStore {
  return {
    async findActiveClient(clientId) {
      const rows = await database
        .select({
          id: mcpClients.id,
          displayName: mcpClients.displayName,
          secretHash: mcpClients.secretHash,
        })
        .from(mcpClients)
        .where(
          and(
            eq(mcpClients.id, clientId),
            eq(mcpClients.enabled, true),
            eq(mcpClients.allowlisted, true),
            eq(mcpClients.environment, environment),
            isNull(mcpClients.revokedAt),
          ),
        )
        .limit(1);
      return rows[0];
    },
    async registerClient(client) {
      await database.insert(mcpClients).values({ ...client, environment });
    },
    async insertGrants(grants) {
      await database.insert(mcpOauthGrants).values(grants);
    },
    async findUsableGrant(tokenHash, kind, now) {
      const rows = await database
        .select({
          id: mcpOauthGrants.id,
          mcpClientId: mcpOauthGrants.mcpClientId,
          codeChallenge: mcpOauthGrants.codeChallenge,
          redirectUri: mcpOauthGrants.redirectUri,
        })
        .from(mcpOauthGrants)
        .where(
          and(
            eq(mcpOauthGrants.tokenHash, tokenHash),
            eq(mcpOauthGrants.kind, kind),
            isNull(mcpOauthGrants.consumedAt),
            gt(mcpOauthGrants.expiresAt, now),
          ),
        )
        .limit(1);
      return rows[0];
    },
    async consumeGrant(grantId, now) {
      const rows = await database
        .update(mcpOauthGrants)
        .set({ consumedAt: now })
        .where(and(eq(mcpOauthGrants.id, grantId), isNull(mcpOauthGrants.consumedAt)))
        .returning({ id: mcpOauthGrants.id });
      return rows.length > 0;
    },
  };
}

export interface McpOAuthDependencies {
  config: GatewayConfig;
  database: Database;
  audit: AuditWriter;
  adminSecret: string;
  publicBaseUrl: string;
  /** Defaults to the Drizzle store over `database`. */
  store?: McpOAuthStore;
}

/** A validated /authorize request: every field checked against server state. */
interface AuthorizationRequest {
  client: McpOAuthClientRecord;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
}

type AuthorizationValidation =
  { ok: true; request: AuthorizationRequest } | { ok: false; reason: string };

/**
 * The CSP source a form must be allowed to reach for the browser to follow the
 * redirect to `redirectUri`: CSP applies form-action to redirects after a form
 * submission too. http(s) URIs need their exact origin; a custom-scheme URI
 * (a desktop client) has an opaque origin and can only be named by its scheme.
 */
export function formActionSourceFor(redirectUri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
  return /^[a-z][a-z0-9+.-]*:$/u.test(url.protocol) ? url.protocol : undefined;
}

/** What the consent page shows as the destination: the host, or the scheme. */
function redirectDestination(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.host.length > 0 ? url.host : url.protocol;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export function registerMcpOAuthRoutes(
  app: FastifyInstance,
  dependencies: McpOAuthDependencies,
): void {
  const { config, database, audit, adminSecret, publicBaseUrl } = dependencies;
  const store = dependencies.store ?? createDrizzleMcpOAuthStore(database, config.NODE_ENV);
  const activeClient = (clientId: string) => store.findActiveClient(clientId);

  async function issueTokenPair(mcpClientId: string): Promise<TokenPair> {
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    await store.insertGrants([
      {
        mcpClientId,
        kind: 'access',
        tokenHash: sha256Base64Url(accessToken),
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
      },
      {
        mcpClientId,
        kind: 'refresh',
        tokenHash: sha256Base64Url(refreshToken),
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      },
    ]);
    return { accessToken, refreshToken, expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
  }

  function tokenError(reply: FastifyReply, status: number, error: string, description: string) {
    return reply.code(status).send({ error, error_description: description });
  }

  // RFC 8414 / RFC 9728 discovery metadata.
  const authorizationServerMetadata = {
    issuer: publicBaseUrl,
    authorization_endpoint: `${publicBaseUrl}/authorize`,
    token_endpoint: `${publicBaseUrl}/token`,
    registration_endpoint: `${publicBaseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  };
  app.get('/.well-known/oauth-authorization-server', () => authorizationServerMetadata);
  app.get('/.well-known/oauth-protected-resource', () => ({
    resource: `${publicBaseUrl}/mcp`,
    authorization_servers: [publicBaseUrl],
    bearer_methods_supported: ['header'],
  }));

  // RFC 7591 dynamic client registration. Registration is open but inert:
  // a registered client obtains tokens only through /authorize, which is
  // gated by the admin password and an explicit Approve on the consent page.
  // Public clients only (PKCE, no usable secret).
  app.post('/register', {
    config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    async handler(request, reply) {
      const correlationId = request.id;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
        : [];
      if (
        redirectUris.length === 0 ||
        !redirectUris.every((uri) =>
          isAllowlistedMcpOAuthRedirect(uri, config.MCP_OAUTH_REDIRECT_ALLOWLIST),
        )
      ) {
        await audit.write({
          correlationId,
          operation: 'mcp_oauth_register',
          result: 'denied',
          metadata: { reason: 'redirect_uris_not_allowlisted' },
        });
        return reply.code(400).send({
          error: 'invalid_redirect_uri',
          error_description: 'Every redirect_uris entry must be allowlisted on the gateway',
        });
      }

      const clientName =
        typeof body.client_name === 'string' && body.client_name.trim().length > 0
          ? body.client_name.trim().slice(0, 120)
          : 'Dynamically registered MCP client';
      const clientId = `dcr-${randomBytes(9).toString('base64url')}`;
      // The generated secret is discarded: Basic authentication can never
      // match, so dynamically registered clients are PKCE-only by design.
      await store.registerClient({
        id: clientId,
        displayName: clientName,
        secretHash: await hashClientSecret(randomBytes(32).toString('base64url')),
      });
      await audit.write({
        mcpClientId: clientId,
        correlationId,
        operation: 'mcp_oauth_register',
        result: 'succeeded',
        metadata: { clientName },
      });
      return reply.code(201).send({
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    },
  });

  /**
   * Checks an authorization request exactly as received, whether it comes
   * from the client's GET or from the consent form's hidden fields: the form
   * is only a carrier, so nothing it echoes back is trusted.
   */
  async function validateAuthorizationRequest(
    params: Record<string, unknown>,
  ): Promise<AuthorizationValidation> {
    const clientId = typeof params.client_id === 'string' ? params.client_id : undefined;
    const redirectUri = typeof params.redirect_uri === 'string' ? params.redirect_uri : undefined;
    const codeChallenge =
      typeof params.code_challenge === 'string' ? params.code_challenge : undefined;
    const state = typeof params.state === 'string' ? params.state : undefined;

    if (params.response_type !== 'code') return { ok: false, reason: 'response_type must be code' };
    if (!clientId || !redirectUri || !codeChallenge) {
      return { ok: false, reason: 'client_id, redirect_uri, and code_challenge are required' };
    }
    if (params.code_challenge_method !== 'S256') {
      return { ok: false, reason: 'code_challenge_method must be S256' };
    }
    if (
      !isAllowlistedMcpOAuthRedirect(redirectUri, config.MCP_OAUTH_REDIRECT_ALLOWLIST) ||
      formActionSourceFor(redirectUri) === undefined
    ) {
      return { ok: false, reason: 'redirect_uri is not allowlisted' };
    }
    const client = await activeClient(clientId);
    if (!client) return { ok: false, reason: 'unknown client_id' };
    return { ok: true, request: { client, redirectUri, codeChallenge, state } };
  }

  async function rejectAuthorization(
    reply: FastifyReply,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    await audit.write({
      correlationId,
      operation: 'mcp_oauth_authorize',
      result: 'denied',
      metadata: { reason },
    });
    await reply.code(400).send({ error: 'invalid_request', error_description: reason });
  }

  const authorizeRoute = {
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    // The gateway is single-operator: the resource owner is whoever holds the
    // admin password.
    preHandler: createAdminBasicAuthHook(adminSecret),
  };

  // Shows what is being authorized and issues nothing. Browsers resend cached
  // Basic credentials on a cross-site navigation, so a GET that minted a code
  // would let any page the operator visits connect a client of its choosing.
  app.get('/authorize', {
    ...authorizeRoute,
    async handler(request, reply) {
      const validation = await validateAuthorizationRequest(
        request.query as Record<string, unknown>,
      );
      if (!validation.ok) return rejectAuthorization(reply, request.id, validation.reason);
      const { client, redirectUri, codeChallenge, state } = validation.request;
      // Only the approved redirect's origin is added to form-action: without
      // it, browsers that enforce form-action on redirects would block the
      // hop from POST /authorize back to the client.
      const formActionSource = formActionSourceFor(redirectUri);
      reply.header(
        'content-security-policy',
        htmlContentSecurityPolicy(formActionSource === undefined ? [] : [formActionSource]),
      );
      return reply.type('text/html; charset=utf-8').send(
        renderConsentPage({
          clientName: client.displayName,
          clientId: client.id,
          redirectDestination: redirectDestination(redirectUri),
          fields: {
            response_type: 'code',
            client_id: client.id,
            redirect_uri: redirectUri,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            ...(state === undefined ? {} : { state }),
          },
        }),
      );
    },
  });

  // The consent form's target. Reached only from the gateway's own page: the
  // same-origin check in http-security.ts refuses cross-site posts before the
  // password is even looked at.
  app.post('/authorize', {
    ...authorizeRoute,
    async handler(request, reply) {
      const correlationId = request.id;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const validation = await validateAuthorizationRequest(body);
      if (!validation.ok) return rejectAuthorization(reply, correlationId, validation.reason);
      const { client, redirectUri, codeChallenge, state } = validation.request;

      const destination = new URL(redirectUri);
      if (body.decision === 'deny') {
        await audit.write({
          mcpClientId: client.id,
          correlationId,
          operation: 'mcp_oauth_authorize',
          result: 'denied',
          metadata: { decision: 'deny', reason: 'operator_denied' },
        });
        destination.searchParams.set('error', 'access_denied');
        if (state !== undefined) destination.searchParams.set('state', state);
        return reply.redirect(destination.toString(), 303);
      }
      if (body.decision !== 'approve') {
        return rejectAuthorization(reply, correlationId, 'decision must be approve or deny');
      }

      const code = randomBytes(32).toString('base64url');
      await store.insertGrants([
        {
          mcpClientId: client.id,
          kind: 'code',
          tokenHash: sha256Base64Url(code),
          codeChallenge,
          redirectUri,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      ]);
      await audit.write({
        mcpClientId: client.id,
        correlationId,
        operation: 'mcp_oauth_authorize',
        result: 'succeeded',
        metadata: { decision: 'approve' },
      });

      destination.searchParams.set('code', code);
      if (state !== undefined) destination.searchParams.set('state', state);
      // 303: the client's callback must be fetched with GET, not re-POSTed.
      return reply.redirect(destination.toString(), 303);
    },
  });

  app.post('/token', {
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    async handler(request, reply) {
      const correlationId = request.id;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';

      const denyAudit = (reason: string) =>
        audit.write({
          correlationId,
          operation: 'mcp_oauth_token',
          result: 'denied',
          metadata: { reason, grantType },
        });

      if (grantType === 'authorization_code') {
        const code = typeof body.code === 'string' ? body.code : '';
        const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
        const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined;
        const clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
        if (!code || !codeVerifier) {
          await denyAudit('missing_code_or_verifier');
          return tokenError(reply, 400, 'invalid_request', 'code and code_verifier are required');
        }

        const now = new Date();
        const grant = await store.findUsableGrant(sha256Base64Url(code), 'code', now);
        if (
          !grant ||
          (clientId !== undefined && clientId !== grant.mcpClientId) ||
          (redirectUri !== undefined && redirectUri !== grant.redirectUri) ||
          !grant.codeChallenge ||
          !verifyPkceS256(codeVerifier, grant.codeChallenge)
        ) {
          await denyAudit('invalid_code_or_pkce');
          return tokenError(reply, 400, 'invalid_grant', 'Authorization code is invalid');
        }
        const client = await activeClient(grant.mcpClientId);
        if (!client) {
          await denyAudit('client_inactive');
          return tokenError(reply, 400, 'invalid_grant', 'Client is not active');
        }
        // Empty string counts as absent: public PKCE clients send no secret.
        const clientSecret =
          typeof body.client_secret === 'string' && body.client_secret.length > 0
            ? body.client_secret
            : undefined;
        if (
          clientSecret !== undefined &&
          !(await verifyClientSecret(clientSecret, client.secretHash))
        ) {
          await denyAudit('client_secret_mismatch');
          return tokenError(reply, 401, 'invalid_client', 'Client authentication failed');
        }

        if (!(await store.consumeGrant(grant.id, now))) {
          await denyAudit('code_already_used');
          return tokenError(reply, 400, 'invalid_grant', 'Authorization code is invalid');
        }
        const pair = await issueTokenPair(client.id);
        await audit.write({
          mcpClientId: client.id,
          correlationId,
          operation: 'mcp_oauth_token',
          result: 'succeeded',
          metadata: { grantType },
        });
        return reply.send({
          access_token: pair.accessToken,
          token_type: 'Bearer',
          expires_in: pair.expiresInSeconds,
          refresh_token: pair.refreshToken,
        });
      }

      if (grantType === 'refresh_token') {
        const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
        if (!refreshToken) {
          await denyAudit('missing_refresh_token');
          return tokenError(reply, 400, 'invalid_request', 'refresh_token is required');
        }
        const now = new Date();
        const grant = await store.findUsableGrant(sha256Base64Url(refreshToken), 'refresh', now);
        const client = grant ? await activeClient(grant.mcpClientId) : undefined;
        if (!grant || !client) {
          await denyAudit('invalid_refresh_token');
          return tokenError(reply, 400, 'invalid_grant', 'Refresh token is invalid');
        }

        // Rotation: the used refresh token is consumed and a new pair issued.
        if (!(await store.consumeGrant(grant.id, now))) {
          await denyAudit('refresh_token_already_used');
          return tokenError(reply, 400, 'invalid_grant', 'Refresh token is invalid');
        }
        const pair = await issueTokenPair(client.id);
        await audit.write({
          mcpClientId: client.id,
          correlationId,
          operation: 'mcp_oauth_token',
          result: 'succeeded',
          metadata: { grantType },
        });
        return reply.send({
          access_token: pair.accessToken,
          token_type: 'Bearer',
          expires_in: pair.expiresInSeconds,
          refresh_token: pair.refreshToken,
        });
      }

      await denyAudit('unsupported_grant_type');
      return tokenError(reply, 400, 'unsupported_grant_type', 'Unsupported grant_type');
    },
  });
}
