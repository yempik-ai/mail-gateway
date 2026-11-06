import { GatewayError } from '@yempik/core';
import { decryptToken, encryptToken, type TokenKeyring } from '@yempik/security';
import { createOAuthState, DEFAULT_STATE_TTL_MS, verifyOAuthState } from './state.js';
import type { OAuthMailbox, OAuthStore } from './store.js';

// Mail.ReadWrite manages the draft and Mail.Send delivers that same existing
// draft. Both are delegated per-mailbox permissions.
export const MICROSOFT_GRAPH_SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'offline_access',
  'openid',
  'profile',
] as const;

export const MICROSOFT_REFRESH_TOKEN_KIND = 'microsoft_refresh_token';

const MICROSOFT_GRAPH_ME_ENDPOINT = 'https://graph.microsoft.com/v1.0/me';

export interface MicrosoftOAuthServiceOptions {
  // Default tenant: used by mailboxes without their own microsoftTenantId.
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
  keyring: TokenKeyring;
  store: OAuthStore;
  fetchImpl?: typeof fetch;
  stateTtlMs?: number;
}

export interface MicrosoftCallbackParams {
  code: string;
  state: string;
}

export interface MicrosoftConnectionResult {
  mailboxId: string;
  emailAddress: string;
  scopes: string[];
}

export interface MicrosoftAccessToken {
  accessToken: string;
  expiresAt: Date;
}

export interface MicrosoftOAuthService {
  authorizationUrl(mailboxId: string, correlationId: string): Promise<string>;
  handleCallback(
    params: MicrosoftCallbackParams,
    correlationId: string,
  ): Promise<MicrosoftConnectionResult>;
  getAccessToken(mailboxId: string, correlationId: string): Promise<MicrosoftAccessToken>;
}

/**
 * Extracts the login identity from an OIDC id_token payload. The token arrives
 * directly from the Microsoft token endpoint over TLS, so decoding without
 * signature verification is safe in this exchange.
 */
export function identityFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  const segments = idToken.split('.');
  const payload = segments[1];
  if (segments.length < 2 || !payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims === null || typeof claims !== 'object') return undefined;
    const record = claims as Record<string, unknown>;
    const candidate = record.preferred_username ?? record.email ?? record.upn;
    return typeof candidate === 'string' && candidate.includes('@') ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

// Endpoints are always pinned to a concrete tenant; /common and /organizations
// would let the signed-in directory decide, defeating the mailbox pinning.
function endpointsFor(tenantId: string): { authorization: string; token: string } {
  const tenantPath = encodeURIComponent(tenantId);
  return {
    authorization: `https://login.microsoftonline.com/${tenantPath}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${tenantPath}/oauth2/v2.0/token`,
  };
}

// `error_description` runs to several lines; only its head carries the AADSTS
// code and the reason, which is all the operator message needs.
const MAX_ERROR_DESCRIPTION_LENGTH = 300;

/**
 * Renders the diagnostic part of a token-endpoint rejection. `error` alone is
 * ambiguous: `invalid_grant` covers both a missing consent (AADSTS65001) and a
 * token that really is revoked or expired (AADSTS70000, AADSTS50173), and only
 * `error_description` and `error_codes` separate them.
 */
function describeTokenError(payload: Record<string, unknown>): string {
  const codes = Array.isArray(payload.error_codes)
    ? payload.error_codes.filter(
        (code): code is number | string => typeof code === 'number' || typeof code === 'string',
      )
    : [];
  const description =
    typeof payload.error_description === 'string'
      ? payload.error_description.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_DESCRIPTION_LENGTH)
      : '';
  const details = [
    ...(codes.length > 0 ? [`error_codes ${codes.join(',')}`] : []),
    ...(description.length > 0 ? [description] : []),
  ];
  return details.length === 0 ? '' : `: ${details.join(' ')}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createMicrosoftOAuthService(
  options: MicrosoftOAuthServiceOptions,
): MicrosoftOAuthService {
  const {
    tenantId,
    clientId,
    clientSecret,
    redirectUri,
    stateSecret,
    keyring,
    store,
    fetchImpl = fetch,
    stateTtlMs = DEFAULT_STATE_TTL_MS,
  } = options;

  function mailboxEndpoints(mailbox: OAuthMailbox): { authorization: string; token: string } {
    return endpointsFor(mailbox.microsoftTenantId ?? tenantId);
  }

  async function requireMicrosoftMailbox(
    mailboxId: string,
    correlationId: string,
  ): Promise<OAuthMailbox> {
    const mailbox = await store.getMailbox(mailboxId);
    if (!mailbox) {
      throw new GatewayError('MAILBOX_NOT_FOUND', `Unknown mailbox: ${mailboxId}`, {
        retryable: false,
        correlationId,
      });
    }
    if (mailbox.provider !== 'microsoft') {
      throw new GatewayError(
        'UNSUPPORTED_OPERATION',
        `Mailbox ${mailboxId} is not a Microsoft mailbox`,
        { retryable: false, correlationId },
      );
    }
    if (!mailbox.enabled) {
      throw new GatewayError('MAILBOX_DISABLED', `Mailbox ${mailboxId} is disabled`, {
        retryable: false,
        correlationId,
      });
    }
    return mailbox;
  }

  async function exchangeToken(
    tokenEndpoint: string,
    body: URLSearchParams,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      throw new GatewayError('PROVIDER_UNAVAILABLE', 'Microsoft token endpoint is unreachable', {
        retryable: true,
        correlationId,
        cause: error,
      });
    }
    const payload = await readJson(response);
    if (!response.ok) {
      if (response.status >= 500) {
        throw new GatewayError('PROVIDER_UNAVAILABLE', 'Microsoft token endpoint failed', {
          retryable: true,
          correlationId,
        });
      }
      const providerError = typeof payload.error === 'string' ? payload.error : 'unknown_error';
      throw new GatewayError(
        providerError === 'invalid_grant' ? 'TOKEN_REVOKED' : 'AUTH_REQUIRED',
        `Microsoft rejected the token request (${providerError})${describeTokenError(payload)}`,
        { retryable: false, correlationId },
      );
    }
    return payload;
  }

  return {
    async authorizationUrl(mailboxId, correlationId) {
      const mailbox = await requireMicrosoftMailbox(mailboxId, correlationId);
      const url = new URL(mailboxEndpoints(mailbox).authorization);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', MICROSOFT_GRAPH_SCOPES.join(' '));
      url.searchParams.set('prompt', 'select_account');
      url.searchParams.set('login_hint', mailbox.emailAddress);
      url.searchParams.set('state', createOAuthState(mailboxId, stateSecret));
      return url.toString();
    },

    async handleCallback(params, correlationId) {
      const statePayload = verifyOAuthState(params.state, stateSecret, stateTtlMs);
      if (!statePayload) {
        throw new GatewayError('AUTH_REQUIRED', 'Invalid or expired OAuth state', {
          retryable: false,
          correlationId,
        });
      }
      const mailbox = await requireMicrosoftMailbox(statePayload.mailboxId, correlationId);

      const tokenPayload = await exchangeToken(
        mailboxEndpoints(mailbox).token,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
        correlationId,
      );

      const accessToken = tokenPayload.access_token;
      const refreshToken = tokenPayload.refresh_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new GatewayError('AUTH_REQUIRED', 'Microsoft returned no access token', {
          retryable: false,
          correlationId,
        });
      }
      if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        throw new GatewayError('AUTH_REQUIRED', 'Microsoft returned no refresh token', {
          retryable: false,
          correlationId,
        });
      }

      const grantedScopes =
        typeof tokenPayload.scope === 'string' ? tokenPayload.scope.split(' ').filter(Boolean) : [];
      const requiredMailScopes = ['Mail.ReadWrite', 'Mail.Send'];
      const missingMailScopes = requiredMailScopes.filter(
        (required) =>
          !grantedScopes.some(
            (scope) => scope === required || scope === `https://graph.microsoft.com/${required}`,
          ),
      );
      if (missingMailScopes.length > 0) {
        throw new GatewayError(
          'AUTH_REQUIRED',
          `Required Microsoft scopes were not granted: ${missingMailScopes.join(', ')}`,
          {
            retryable: false,
            correlationId,
          },
        );
      }

      // The id_token (openid scope) already carries the login identity; Graph
      // /me would require the User.Read permission the gateway deliberately
      // does not request, so the endpoint is only a fallback.
      let authenticatedAddress = identityFromIdToken(tokenPayload.id_token);
      if (!authenticatedAddress) {
        let profileResponse: Response;
        try {
          profileResponse = await fetchImpl(MICROSOFT_GRAPH_ME_ENDPOINT, {
            headers: { authorization: `Bearer ${accessToken}` },
          });
        } catch (error) {
          throw new GatewayError(
            'PROVIDER_UNAVAILABLE',
            'Microsoft Graph profile endpoint is unreachable',
            {
              retryable: true,
              correlationId,
              cause: error,
            },
          );
        }
        const profile = await readJson(profileResponse);
        const profileAddress = profile.mail ?? profile.userPrincipalName;
        if (!profileResponse.ok || typeof profileAddress !== 'string') {
          throw new GatewayError(
            profileResponse.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'AUTH_REQUIRED',
            'Unable to determine the authenticated Microsoft identity',
            { retryable: profileResponse.status >= 500, correlationId },
          );
        }
        authenticatedAddress = profileAddress;
      }

      const expectedAddress = normalizeEmailAddress(mailbox.emailAddress);
      const actualAddress = normalizeEmailAddress(authenticatedAddress);
      if (expectedAddress !== actualAddress) {
        await store.markConnectionError(mailbox.id, 'microsoft', 'MAILBOX_MISMATCH');
        throw new GatewayError(
          'MAILBOX_MISMATCH',
          `Authenticated account ${actualAddress} does not match configured mailbox ${expectedAddress}`,
          { retryable: false, correlationId },
        );
      }

      await store.completeConnection({
        mailboxId: mailbox.id,
        provider: 'microsoft',
        providerAccountId: actualAddress,
        scopes: grantedScopes,
        tokenKind: MICROSOFT_REFRESH_TOKEN_KIND,
        encryptedRefreshToken: encryptToken(refreshToken, keyring),
      });

      return { mailboxId: mailbox.id, emailAddress: actualAddress, scopes: grantedScopes };
    },

    async getAccessToken(mailboxId, correlationId) {
      const mailbox = await requireMicrosoftMailbox(mailboxId, correlationId);
      const encrypted = await store.getActiveRefreshToken(
        mailbox.id,
        'microsoft',
        MICROSOFT_REFRESH_TOKEN_KIND,
      );
      if (!encrypted) {
        throw new GatewayError('AUTH_REQUIRED', `Mailbox ${mailboxId} is not connected`, {
          retryable: false,
          correlationId,
        });
      }

      let tokenPayload: Record<string, unknown>;
      try {
        // No `scope` on purpose. A refresh may only narrow the consented set,
        // never widen it: asking for a scope the grant does not hold makes the
        // v2 endpoint answer invalid_grant (AADSTS65001), which the catch below
        // reads as a revocation and would destroy a valid connection. Omitting
        // the parameter returns the originally consented scopes, so widening
        // MICROSOFT_GRAPH_SCOPES in code degrades to "cannot send" until the
        // operator reconnects instead of also killing read access. Sending the
        // stored scopes would be equivalent, but the store hands out the
        // refresh token alone, so omitting is the same behaviour for free.
        // authorizationUrl still asks for the full set: that is how a grant
        // gets widened.
        tokenPayload = await exchangeToken(
          mailboxEndpoints(mailbox).token,
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: decryptToken(encrypted, keyring),
            client_id: clientId,
            client_secret: clientSecret,
          }),
          correlationId,
        );
      } catch (error) {
        if (error instanceof GatewayError && error.code === 'TOKEN_REVOKED') {
          await store.markConnectionRevoked(mailbox.id, 'microsoft');
        }
        throw error;
      }

      const accessToken = tokenPayload.access_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new GatewayError('PROVIDER_UNAVAILABLE', 'Microsoft returned no access token', {
          retryable: true,
          correlationId,
        });
      }
      const expiresInSeconds =
        typeof tokenPayload.expires_in === 'number' && tokenPayload.expires_in > 0
          ? tokenPayload.expires_in
          : 3600;
      await store.markTokenRefreshed(mailbox.id);
      return { accessToken, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
    },
  };
}
