import { GatewayError } from '@yempik/core';
import { decryptToken, encryptToken, type TokenKeyring } from '@yempik/security';
import { createOAuthState, DEFAULT_STATE_TTL_MS, verifyOAuthState } from './state.js';
import type { OAuthMailbox, OAuthStore } from './store.js';

// gmail.compose is sufficient both to manage and deliver an existing draft;
// broader gmail.send, gmail.modify and mail.google.com grants are unnecessary.
export const GOOGLE_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
] as const;

export const GOOGLE_REFRESH_TOKEN_KIND = 'google_refresh_token';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export interface GoogleOAuthServiceOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
  keyring: TokenKeyring;
  store: OAuthStore;
  fetchImpl?: typeof fetch;
  stateTtlMs?: number;
}

export interface GoogleCallbackParams {
  code: string;
  state: string;
}

export interface GoogleConnectionResult {
  mailboxId: string;
  emailAddress: string;
  scopes: string[];
}

export interface GoogleAccessToken {
  accessToken: string;
  expiresAt: Date;
}

export interface GoogleOAuthService {
  authorizationUrl(mailboxId: string, correlationId: string): Promise<string>;
  handleCallback(
    params: GoogleCallbackParams,
    correlationId: string,
  ): Promise<GoogleConnectionResult>;
  getAccessToken(mailboxId: string, correlationId: string): Promise<GoogleAccessToken>;
}

export function normalizeEmailAddress(address: string): string {
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

export function createGoogleOAuthService(options: GoogleOAuthServiceOptions): GoogleOAuthService {
  const {
    clientId,
    clientSecret,
    redirectUri,
    stateSecret,
    keyring,
    store,
    fetchImpl = fetch,
    stateTtlMs = DEFAULT_STATE_TTL_MS,
  } = options;

  async function requireGmailMailbox(
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
    if (mailbox.provider !== 'gmail') {
      throw new GatewayError(
        'UNSUPPORTED_OPERATION',
        `Mailbox ${mailboxId} is not a Gmail mailbox`,
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
    body: URLSearchParams,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      throw new GatewayError('PROVIDER_UNAVAILABLE', 'Google token endpoint is unreachable', {
        retryable: true,
        correlationId,
        cause: error,
      });
    }
    const payload = await readJson(response);
    if (!response.ok) {
      if (response.status >= 500) {
        throw new GatewayError('PROVIDER_UNAVAILABLE', 'Google token endpoint failed', {
          retryable: true,
          correlationId,
        });
      }
      const providerError = typeof payload.error === 'string' ? payload.error : 'unknown_error';
      throw new GatewayError(
        providerError === 'invalid_grant' ? 'TOKEN_REVOKED' : 'AUTH_REQUIRED',
        `Google rejected the token request (${providerError})`,
        { retryable: false, correlationId },
      );
    }
    return payload;
  }

  return {
    async authorizationUrl(mailboxId, correlationId) {
      const mailbox = await requireGmailMailbox(mailboxId, correlationId);
      const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', GOOGLE_GMAIL_SCOPES.join(' '));
      // offline + consent guarantees a refresh token on every (re)connect.
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('include_granted_scopes', 'false');
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
      const mailbox = await requireGmailMailbox(statePayload.mailboxId, correlationId);

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
        throw new GatewayError('AUTH_REQUIRED', 'Google returned no access token', {
          retryable: false,
          correlationId,
        });
      }
      if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        throw new GatewayError(
          'AUTH_REQUIRED',
          'Google returned no refresh token; revoke the previous grant for this account and retry',
          { retryable: false, correlationId },
        );
      }

      const grantedScopes =
        typeof tokenPayload.scope === 'string' ? tokenPayload.scope.split(' ').filter(Boolean) : [];
      const missingScopes = GOOGLE_GMAIL_SCOPES.filter((scope) => !grantedScopes.includes(scope));
      if (missingScopes.length > 0) {
        throw new GatewayError(
          'AUTH_REQUIRED',
          `Required Gmail scopes were not granted: ${missingScopes.join(', ')}`,
          { retryable: false, correlationId },
        );
      }

      let profileResponse: Response;
      try {
        profileResponse = await fetchImpl(GMAIL_PROFILE_ENDPOINT, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
      } catch (error) {
        throw new GatewayError('PROVIDER_UNAVAILABLE', 'Gmail profile endpoint is unreachable', {
          retryable: true,
          correlationId,
          cause: error,
        });
      }
      const profile = await readJson(profileResponse);
      const authenticatedAddress = profile.emailAddress;
      if (!profileResponse.ok || typeof authenticatedAddress !== 'string') {
        throw new GatewayError(
          profileResponse.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'AUTH_REQUIRED',
          'Unable to read the authenticated Gmail profile',
          { retryable: profileResponse.status >= 500, correlationId },
        );
      }

      const expectedAddress = normalizeEmailAddress(mailbox.emailAddress);
      const actualAddress = normalizeEmailAddress(authenticatedAddress);
      if (expectedAddress !== actualAddress) {
        await store.markConnectionError(mailbox.id, 'gmail', 'MAILBOX_MISMATCH');
        throw new GatewayError(
          'MAILBOX_MISMATCH',
          `Authenticated account ${actualAddress} does not match configured mailbox ${expectedAddress}`,
          { retryable: false, correlationId },
        );
      }

      await store.completeConnection({
        mailboxId: mailbox.id,
        provider: 'gmail',
        providerAccountId: actualAddress,
        scopes: grantedScopes,
        tokenKind: GOOGLE_REFRESH_TOKEN_KIND,
        encryptedRefreshToken: encryptToken(refreshToken, keyring),
      });

      return { mailboxId: mailbox.id, emailAddress: actualAddress, scopes: grantedScopes };
    },

    async getAccessToken(mailboxId, correlationId) {
      const mailbox = await requireGmailMailbox(mailboxId, correlationId);
      const encrypted = await store.getActiveRefreshToken(
        mailbox.id,
        'gmail',
        GOOGLE_REFRESH_TOKEN_KIND,
      );
      if (!encrypted) {
        throw new GatewayError('AUTH_REQUIRED', `Mailbox ${mailboxId} is not connected`, {
          retryable: false,
          correlationId,
        });
      }

      let tokenPayload: Record<string, unknown>;
      try {
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
          await store.markConnectionRevoked(mailbox.id, 'gmail');
        }
        throw error;
      }

      const accessToken = tokenPayload.access_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new GatewayError('PROVIDER_UNAVAILABLE', 'Google returned no access token', {
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
