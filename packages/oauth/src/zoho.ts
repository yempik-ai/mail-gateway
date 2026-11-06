import { GatewayError, ZOHO_REGION_HOSTS, type ZohoRegion } from '@yempik/core';
import { decryptToken, encryptToken, type TokenKeyring } from '@yempik/security';
import { createOAuthState, DEFAULT_STATE_TTL_MS, verifyOAuthState } from './state.js';
import type { OAuthMailbox, OAuthStore } from './store.js';

/**
 * The gateway is a Mailbox Read + Draft Gateway.
 *
 * Zoho differs from Google and Microsoft on one security-relevant point: it has
 * no scope that separates "compose a draft" from "send a message". Saving a
 * draft and sending both go through `POST /messages` under
 * `ZohoMail.messages.CREATE`. The adapter uses the same narrow scope to create
 * and autonomously deliver gateway-managed drafts. See docs/SECURITY.md.
 */
export const ZOHO_MAIL_SCOPES = [
  'ZohoMail.accounts.READ',
  'ZohoMail.folders.READ',
  'ZohoMail.messages.READ',
  'ZohoMail.messages.CREATE',
  'ZohoMail.messages.DELETE',
] as const;

export const ZOHO_REFRESH_TOKEN_KIND = 'zoho_refresh_token';

const REQUIRED_SCOPES = ['ZohoMail.messages.READ', 'ZohoMail.messages.CREATE'] as const;

export interface ZohoOAuthServiceOptions {
  clientId: string;
  clientSecret: string;
  region: ZohoRegion;
  redirectUri: string;
  stateSecret: string;
  keyring: TokenKeyring;
  store: OAuthStore;
  fetchImpl?: typeof fetch;
  stateTtlMs?: number;
}

export interface ZohoCallbackParams {
  code: string;
  state: string;
}

export interface ZohoConnectionResult {
  mailboxId: string;
  emailAddress: string;
  scopes: string[];
}

export interface ZohoAccessToken {
  accessToken: string;
  expiresAt: Date;
}

export interface ZohoOAuthService {
  authorizationUrl(mailboxId: string, correlationId: string): Promise<string>;
  handleCallback(params: ZohoCallbackParams, correlationId: string): Promise<ZohoConnectionResult>;
  getAccessToken(mailboxId: string, correlationId: string): Promise<ZohoAccessToken>;
}

interface ZohoAccountEntry {
  accountId?: unknown;
  primaryEmailAddress?: unknown;
  incomingUserName?: unknown;
}

function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Reads the primary address out of `GET /api/accounts`. Zoho returns the
 * authenticated user's accounts under `data`; the first entry is the account
 * the token was minted for.
 */
export function primaryAddressFromAccounts(payload: Record<string, unknown>): string | undefined {
  const data = payload.data;
  if (!Array.isArray(data)) return undefined;
  const first = data[0] as ZohoAccountEntry | undefined;
  const candidate = first?.primaryEmailAddress ?? first?.incomingUserName;
  return typeof candidate === 'string' && candidate.includes('@') ? candidate : undefined;
}

export function createZohoOAuthService(options: ZohoOAuthServiceOptions): ZohoOAuthService {
  const {
    clientId,
    clientSecret,
    region,
    redirectUri,
    stateSecret,
    keyring,
    store,
    fetchImpl = fetch,
    stateTtlMs = DEFAULT_STATE_TTL_MS,
  } = options;

  const hosts = ZOHO_REGION_HOSTS[region];
  const authorizationEndpoint = `${hosts.accounts}/oauth/v2/auth`;
  const tokenEndpoint = `${hosts.accounts}/oauth/v2/token`;
  const accountsEndpoint = `${hosts.mail}/api/accounts`;

  async function requireZohoMailbox(
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
    if (mailbox.provider !== 'zoho') {
      throw new GatewayError(
        'UNSUPPORTED_OPERATION',
        `Mailbox ${mailboxId} is not a Zoho mailbox`,
        {
          retryable: false,
          correlationId,
        },
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
      throw new GatewayError('PROVIDER_UNAVAILABLE', 'Zoho token endpoint is unreachable', {
        retryable: true,
        correlationId,
        cause: error,
      });
    }

    const payload = await readJson(response);
    if (response.status >= 500) {
      throw new GatewayError('PROVIDER_UNAVAILABLE', 'Zoho token endpoint failed', {
        retryable: true,
        correlationId,
      });
    }
    // Zoho answers OAuth failures with HTTP 200 and an `error` field, so the
    // status code alone is not enough to decide the outcome.
    const providerError = typeof payload.error === 'string' ? payload.error : undefined;
    if (!response.ok || providerError) {
      const code = providerError ?? 'unknown_error';
      const revoked = code === 'invalid_code' || code === 'invalid_grant';
      throw new GatewayError(
        revoked ? 'TOKEN_REVOKED' : 'AUTH_REQUIRED',
        `Zoho rejected the token request (${code})`,
        { retryable: false, correlationId },
      );
    }
    return payload;
  }

  return {
    async authorizationUrl(mailboxId, correlationId) {
      await requireZohoMailbox(mailboxId, correlationId);
      const url = new URL(authorizationEndpoint);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      // Zoho separates scopes with commas, not spaces.
      url.searchParams.set('scope', ZOHO_MAIL_SCOPES.join(','));
      // Both are required for Zoho to return a refresh token at all.
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
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
      const mailbox = await requireZohoMailbox(statePayload.mailboxId, correlationId);

      const tokenPayload = await exchangeToken(
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
        throw new GatewayError('AUTH_REQUIRED', 'Zoho returned no access token', {
          retryable: false,
          correlationId,
        });
      }
      if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        throw new GatewayError(
          'AUTH_REQUIRED',
          'Zoho returned no refresh token: re-run the consent flow',
          { retryable: false, correlationId },
        );
      }

      const grantedScopes =
        typeof tokenPayload.scope === 'string'
          ? tokenPayload.scope.split(/[\s,]+/).filter(Boolean)
          : [];
      const missing = REQUIRED_SCOPES.filter((scope) => !grantedScopes.includes(scope));
      if (missing.length > 0) {
        throw new GatewayError(
          'AUTH_REQUIRED',
          `Required Zoho scopes were not granted: ${missing.join(', ')}`,
          { retryable: false, correlationId },
        );
      }

      let accountsResponse: Response;
      try {
        accountsResponse = await fetchImpl(accountsEndpoint, {
          headers: { authorization: `Zoho-oauthtoken ${accessToken}` },
        });
      } catch (error) {
        throw new GatewayError('PROVIDER_UNAVAILABLE', 'Zoho accounts endpoint is unreachable', {
          retryable: true,
          correlationId,
          cause: error,
        });
      }

      const accountsPayload = await readJson(accountsResponse);
      const authenticatedAddress = primaryAddressFromAccounts(accountsPayload);
      if (!accountsResponse.ok || !authenticatedAddress) {
        throw new GatewayError(
          accountsResponse.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'AUTH_REQUIRED',
          'Unable to determine the authenticated Zoho identity',
          { retryable: accountsResponse.status >= 500, correlationId },
        );
      }

      const expectedAddress = normalizeEmailAddress(mailbox.emailAddress);
      const actualAddress = normalizeEmailAddress(authenticatedAddress);
      if (expectedAddress !== actualAddress) {
        await store.markConnectionError(mailbox.id, 'zoho', 'MAILBOX_MISMATCH');
        throw new GatewayError(
          'MAILBOX_MISMATCH',
          `Authenticated account ${actualAddress} does not match configured mailbox ${expectedAddress}`,
          { retryable: false, correlationId },
        );
      }

      await store.completeConnection({
        mailboxId: mailbox.id,
        provider: 'zoho',
        providerAccountId: actualAddress,
        scopes: grantedScopes,
        tokenKind: ZOHO_REFRESH_TOKEN_KIND,
        encryptedRefreshToken: encryptToken(refreshToken, keyring),
      });

      return { mailboxId: mailbox.id, emailAddress: actualAddress, scopes: grantedScopes };
    },

    async getAccessToken(mailboxId, correlationId) {
      const mailbox = await requireZohoMailbox(mailboxId, correlationId);
      const encrypted = await store.getActiveRefreshToken(
        mailbox.id,
        'zoho',
        ZOHO_REFRESH_TOKEN_KIND,
      );
      if (!encrypted) {
        throw new GatewayError('AUTH_REQUIRED', `Mailbox ${mailboxId} is not connected`, {
          retryable: false,
          correlationId,
        });
      }

      let tokenPayload: Record<string, unknown>;
      try {
        // Zoho refresh tokens do not expire and are not rotated on use, so the
        // stored ciphertext stays valid until the grant is revoked.
        tokenPayload = await exchangeToken(
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
          await store.markConnectionRevoked(mailbox.id, 'zoho');
        }
        throw error;
      }

      const accessToken = tokenPayload.access_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new GatewayError('PROVIDER_UNAVAILABLE', 'Zoho returned no access token', {
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
