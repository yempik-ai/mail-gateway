import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../packages/core/src/index.js';
import { decryptToken, loadTokenKeyring } from '../../packages/security/src/index.js';
import {
  createGoogleOAuthService,
  createOAuthState,
  GOOGLE_GMAIL_SCOPES,
  GOOGLE_REFRESH_TOKEN_KIND,
  type CompleteConnectionInput,
  type OAuthMailbox,
  type OAuthStore,
} from '../../packages/oauth/src/index.js';
import { requestBody, requestHref } from '../support/fetch.js';

const STATE_SECRET = 'a-state-secret-longer-than-sixteen';
const KEYRING = loadTokenKeyring('{"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}', 1);
const MAILBOX: OAuthMailbox = {
  id: 'primary-gmail',
  provider: 'gmail',
  emailAddress: 'outreach@example.com',
  enabled: true,
  microsoftTenantId: null,
};
const CORRELATION_ID = '3f1e9f7a-0000-4000-8000-000000000000';
const GRANTED_SCOPE = GOOGLE_GMAIL_SCOPES.join(' ');

interface FakeStore {
  store: OAuthStore;
  completed: CompleteConnectionInput[];
  errors: { mailboxId: string; errorCode: string }[];
  revoked: string[];
  refreshed: string[];
}

function createFakeStore(mailbox: OAuthMailbox | undefined = MAILBOX): FakeStore {
  const completed: CompleteConnectionInput[] = [];
  const errors: { mailboxId: string; errorCode: string }[] = [];
  const revoked: string[] = [];
  const refreshed: string[] = [];
  return {
    completed,
    errors,
    revoked,
    refreshed,
    store: {
      getMailbox: (mailboxId) =>
        Promise.resolve(mailbox && mailbox.id === mailboxId ? mailbox : undefined),
      completeConnection: (input) => {
        completed.push(input);
        return Promise.resolve();
      },
      markConnectionError: (mailboxId, _provider, errorCode) => {
        errors.push({ mailboxId, errorCode });
        return Promise.resolve();
      },
      markConnectionRevoked: (mailboxId) => {
        revoked.push(mailboxId);
        return Promise.resolve();
      },
      getActiveRefreshToken: () => Promise.resolve(undefined),
      markTokenRefreshed: (mailboxId) => {
        refreshed.push(mailboxId);
        return Promise.resolve();
      },
    },
  };
}

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createFakeFetch(handlers: {
  token?: (init?: RequestInit) => Response;
  profile?: () => Response;
}): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = requestHref(input);
    calls.push(init === undefined ? { url } : { url, init });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Promise.resolve(handlers.token?.(init) ?? jsonResponse(500, {}));
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile')) {
      return Promise.resolve(handlers.profile?.() ?? jsonResponse(500, {}));
    }
    return Promise.resolve(jsonResponse(404, {}));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function createService(fake: FakeStore, fetchImpl: typeof fetch) {
  return createGoogleOAuthService({
    clientId: 'client-id.apps.googleusercontent.com',
    clientSecret: 'client-secret-value',
    redirectUri: 'http://localhost:3000/oauth/google/callback',
    stateSecret: STATE_SECRET,
    keyring: KEYRING,
    store: fake.store,
    fetchImpl,
  });
}

async function expectGatewayError(promise: Promise<unknown>, code: string): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.code).toBe(code);
    return gatewayError;
  }
  throw new Error(`Expected GatewayError ${code} to be thrown`);
}

describe('Google OAuth authorization URL', () => {
  it('requests only read and compose scopes with offline consent', async () => {
    const fake = createFakeStore();
    const { fetchImpl } = createFakeFetch({});
    const service = createService(fake, fetchImpl);

    const url = new URL(await service.authorizationUrl(MAILBOX.id, CORRELATION_ID));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GRANTED_SCOPE);
    expect(url.searchParams.get('scope')).not.toContain('gmail.send');
    expect(url.searchParams.get('scope')).not.toContain('gmail.modify');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('login_hint')).toBe(MAILBOX.emailAddress);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/oauth/google/callback',
    );
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('refuses unknown, non-Gmail, and disabled mailboxes', async () => {
    const { fetchImpl } = createFakeFetch({});
    await expectGatewayError(
      createService(createFakeStore(undefined), fetchImpl).authorizationUrl(
        'missing',
        CORRELATION_ID,
      ),
      'MAILBOX_NOT_FOUND',
    );
    await expectGatewayError(
      createService(
        createFakeStore({ ...MAILBOX, provider: 'microsoft' }),
        fetchImpl,
      ).authorizationUrl(MAILBOX.id, CORRELATION_ID),
      'UNSUPPORTED_OPERATION',
    );
    await expectGatewayError(
      createService(createFakeStore({ ...MAILBOX, enabled: false }), fetchImpl).authorizationUrl(
        MAILBOX.id,
        CORRELATION_ID,
      ),
      'MAILBOX_DISABLED',
    );
  });
});

describe('Google OAuth callback', () => {
  const tokenSuccess = () =>
    jsonResponse(200, {
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      scope: GRANTED_SCOPE,
      token_type: 'Bearer',
      expires_in: 3599,
    });

  it('verifies identity, encrypts the refresh token, and completes the connection', async () => {
    const fake = createFakeStore();
    const { fetchImpl, calls } = createFakeFetch({
      token: tokenSuccess,
      profile: () => jsonResponse(200, { emailAddress: 'Outreach@Example.com' }),
    });
    const service = createService(fake, fetchImpl);

    const result = await service.handleCallback(
      { code: 'auth-code', state: createOAuthState(MAILBOX.id, STATE_SECRET) },
      CORRELATION_ID,
    );

    expect(result).toEqual({
      mailboxId: MAILBOX.id,
      emailAddress: 'outreach@example.com',
      scopes: GRANTED_SCOPE.split(' '),
    });
    const tokenCall = calls.find((call) => call.url.includes('oauth2.googleapis.com'));
    const body = requestBody(tokenCall?.init);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code');

    expect(fake.completed).toHaveLength(1);
    const saved = fake.completed[0]!;
    expect(saved.provider).toBe('gmail');
    expect(saved.tokenKind).toBe(GOOGLE_REFRESH_TOKEN_KIND);
    expect(saved.providerAccountId).toBe('outreach@example.com');
    expect(decryptToken(saved.encryptedRefreshToken, KEYRING)).toBe('refresh-token-value');
  });

  it('rejects a mismatched account without saving anything', async () => {
    const fake = createFakeStore();
    const { fetchImpl } = createFakeFetch({
      token: tokenSuccess,
      profile: () => jsonResponse(200, { emailAddress: 'someone-else@gmail.com' }),
    });
    const service = createService(fake, fetchImpl);

    await expectGatewayError(
      service.handleCallback(
        { code: 'auth-code', state: createOAuthState(MAILBOX.id, STATE_SECRET) },
        CORRELATION_ID,
      ),
      'MAILBOX_MISMATCH',
    );
    expect(fake.completed).toHaveLength(0);
    expect(fake.errors).toEqual([{ mailboxId: MAILBOX.id, errorCode: 'MAILBOX_MISMATCH' }]);
  });

  it('rejects an invalid state before contacting Google', async () => {
    const fake = createFakeStore();
    const { fetchImpl, calls } = createFakeFetch({});
    const service = createService(fake, fetchImpl);

    await expectGatewayError(
      service.handleCallback({ code: 'auth-code', state: 'forged-state' }, CORRELATION_ID),
      'AUTH_REQUIRED',
    );
    expect(calls).toHaveLength(0);
    expect(fake.completed).toHaveLength(0);
  });

  it('rejects a grant without refresh token', async () => {
    const fake = createFakeStore();
    const { fetchImpl } = createFakeFetch({
      token: () =>
        jsonResponse(200, {
          access_token: 'access-token-value',
          scope: GRANTED_SCOPE,
          expires_in: 3599,
        }),
    });
    const service = createService(fake, fetchImpl);

    await expectGatewayError(
      service.handleCallback(
        { code: 'auth-code', state: createOAuthState(MAILBOX.id, STATE_SECRET) },
        CORRELATION_ID,
      ),
      'AUTH_REQUIRED',
    );
    expect(fake.completed).toHaveLength(0);
  });

  it('rejects a grant missing a required scope', async () => {
    const fake = createFakeStore();
    const { fetchImpl } = createFakeFetch({
      token: () =>
        jsonResponse(200, {
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value',
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
          expires_in: 3599,
        }),
    });
    const service = createService(fake, fetchImpl);

    await expectGatewayError(
      service.handleCallback(
        { code: 'auth-code', state: createOAuthState(MAILBOX.id, STATE_SECRET) },
        CORRELATION_ID,
      ),
      'AUTH_REQUIRED',
    );
    expect(fake.completed).toHaveLength(0);
  });
});

describe('Google access token refresh', () => {
  it('marks the connection revoked when Google reports invalid_grant', async () => {
    const fake = createFakeStore();
    fake.store.getActiveRefreshToken = () =>
      Promise.resolve({
        ciphertext: 'irrelevant',
        nonce: 'irrelevant',
        authTag: 'irrelevant',
        keyVersion: 1,
      });
    const { fetchImpl } = createFakeFetch({
      token: () => jsonResponse(400, { error: 'invalid_grant' }),
    });
    const service = createGoogleOAuthService({
      clientId: 'client-id.apps.googleusercontent.com',
      clientSecret: 'client-secret-value',
      redirectUri: 'http://localhost:3000/oauth/google/callback',
      stateSecret: STATE_SECRET,
      keyring: KEYRING,
      store: fake.store,
      fetchImpl,
    });

    // decryptToken on fake ciphertext throws before fetch, so build a real one.
    const { encryptToken } = await import('../../packages/security/src/index.js');
    fake.store.getActiveRefreshToken = () =>
      Promise.resolve(encryptToken('refresh-token-value', KEYRING));

    await expectGatewayError(service.getAccessToken(MAILBOX.id, CORRELATION_ID), 'TOKEN_REVOKED');
    expect(fake.revoked).toEqual([MAILBOX.id]);
  });

  it('returns a fresh access token and records the refresh', async () => {
    const fake = createFakeStore();
    const { encryptToken } = await import('../../packages/security/src/index.js');
    fake.store.getActiveRefreshToken = () =>
      Promise.resolve(encryptToken('refresh-token-value', KEYRING));
    const { fetchImpl, calls } = createFakeFetch({
      token: () => jsonResponse(200, { access_token: 'new-access-token', expires_in: 3600 }),
    });
    const service = createService(fake, fetchImpl);

    const token = await service.getAccessToken(MAILBOX.id, CORRELATION_ID);
    expect(token.accessToken).toBe('new-access-token');
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(fake.refreshed).toEqual([MAILBOX.id]);
    const body = requestBody(calls[0]?.init);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-token-value');
  });

  it('requires a stored connection', async () => {
    const fake = createFakeStore();
    const { fetchImpl } = createFakeFetch({});
    const service = createService(fake, fetchImpl);
    await expectGatewayError(service.getAccessToken(MAILBOX.id, CORRELATION_ID), 'AUTH_REQUIRED');
  });
});
