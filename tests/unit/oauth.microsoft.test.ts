import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../packages/core/src/index.js';
import { decryptToken, encryptToken, loadTokenKeyring } from '../../packages/security/src/index.js';
import {
  createMicrosoftOAuthService,
  createOAuthState,
  MICROSOFT_GRAPH_SCOPES,
  MICROSOFT_REFRESH_TOKEN_KIND,
  type CompleteConnectionInput,
  type OAuthMailbox,
  type OAuthStore,
} from '../../packages/oauth/src/index.js';
import { requestBody, requestHref } from '../support/fetch.js';

const STATE_SECRET = 'a-state-secret-longer-than-sixteen';
const KEYRING = loadTokenKeyring('{"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}', 1);
const MAILBOX: OAuthMailbox = {
  id: 'sales-outlook',
  provider: 'microsoft',
  emailAddress: 'hello@corp.example.com',
  enabled: true,
  microsoftTenantId: null,
};
const PINNED_MAILBOX: OAuthMailbox = {
  id: 'pinned-outlook',
  provider: 'microsoft',
  emailAddress: 'alex@it.example.com',
  enabled: true,
  microsoftTenantId: 'other-tenant-id',
};
const CORRELATION_ID = '3f1e9f7a-0000-4000-8000-000000000000';
const GRANTED_SCOPE = 'Mail.ReadWrite Mail.Send offline_access openid profile';

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
    if (/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token/.test(url)) {
      return Promise.resolve(handlers.token?.(init) ?? jsonResponse(500, {}));
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/me')) {
      return Promise.resolve(handlers.profile?.() ?? jsonResponse(500, {}));
    }
    return Promise.resolve(jsonResponse(404, {}));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function createService(fake: FakeStore, fetchImpl: typeof fetch) {
  return createMicrosoftOAuthService({
    tenantId: 'tenant-id',
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    redirectUri: 'http://localhost:3000/oauth/microsoft/callback',
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

describe('Microsoft OAuth authorization URL', () => {
  it('requests the delegated draft and send scopes', async () => {
    const fake = createFakeStore();
    const { fetchImpl } = createFakeFetch({});
    const service = createService(fake, fetchImpl);

    const url = new URL(await service.authorizationUrl(MAILBOX.id, CORRELATION_ID));
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...MICROSOFT_GRAPH_SCOPES]);
    expect(url.searchParams.get('scope')).toContain('Mail.Send');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('login_hint')).toBe(MAILBOX.emailAddress);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/oauth/microsoft/callback',
    );
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('pins the authorize endpoint to the tenant carried by the mailbox', async () => {
    const fake = createFakeStore(PINNED_MAILBOX);
    const { fetchImpl } = createFakeFetch({});
    const service = createService(fake, fetchImpl);

    const url = new URL(await service.authorizationUrl(PINNED_MAILBOX.id, CORRELATION_ID));
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/other-tenant-id/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('login_hint')).toBe(PINNED_MAILBOX.emailAddress);
  });
});

describe('Microsoft OAuth callback', () => {
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
      profile: () => jsonResponse(200, { mail: null, userPrincipalName: 'Hello@Corp.example.com' }),
    });
    const service = createService(fake, fetchImpl);

    const result = await service.handleCallback(
      { code: 'auth-code', state: createOAuthState(MAILBOX.id, STATE_SECRET) },
      CORRELATION_ID,
    );

    expect(result).toEqual({
      mailboxId: MAILBOX.id,
      emailAddress: 'hello@corp.example.com',
      scopes: GRANTED_SCOPE.split(' '),
    });
    const tokenCall = calls.find((call) => call.url.includes('login.microsoftonline.com'));
    const body = requestBody(tokenCall?.init);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code');
    expect(body).toContain('client_secret=client-secret-value');

    expect(fake.completed).toHaveLength(1);
    const saved = fake.completed[0]!;
    expect(saved.provider).toBe('microsoft');
    expect(saved.tokenKind).toBe(MICROSOFT_REFRESH_TOKEN_KIND);
    expect(saved.providerAccountId).toBe('hello@corp.example.com');
    expect(decryptToken(saved.encryptedRefreshToken, KEYRING)).toBe('refresh-token-value');
  });

  it('exchanges the code on the tenant carried by the mailbox', async () => {
    const fake = createFakeStore(PINNED_MAILBOX);
    const { fetchImpl, calls } = createFakeFetch({
      token: tokenSuccess,
      profile: () => jsonResponse(200, { mail: 'alex@it.example.com' }),
    });
    const service = createService(fake, fetchImpl);

    const result = await service.handleCallback(
      { code: 'auth-code', state: createOAuthState(PINNED_MAILBOX.id, STATE_SECRET) },
      CORRELATION_ID,
    );

    expect(result.mailboxId).toBe(PINNED_MAILBOX.id);
    expect(calls[0]?.url).toBe(
      'https://login.microsoftonline.com/other-tenant-id/oauth2/v2.0/token',
    );
    expect(fake.completed).toHaveLength(1);
  });

  it('exchanges the code on the default tenant when the mailbox pins none', async () => {
    const fake = createFakeStore();
    const { fetchImpl, calls } = createFakeFetch({
      token: tokenSuccess,
      profile: () => jsonResponse(200, { mail: 'hello@corp.example.com' }),
    });
    const service = createService(fake, fetchImpl);

    await service.handleCallback(
      { code: 'auth-code', state: createOAuthState(MAILBOX.id, STATE_SECRET) },
      CORRELATION_ID,
    );

    expect(calls[0]?.url).toBe('https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token');
  });

  it('rejects a mismatched account without saving anything', async () => {
    const fake = createFakeStore();
    const { fetchImpl } = createFakeFetch({
      token: tokenSuccess,
      profile: () => jsonResponse(200, { mail: 'someone-else@corp.example.com' }),
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

  it('rejects a grant missing Mail.ReadWrite', async () => {
    const fake = createFakeStore();
    const { fetchImpl } = createFakeFetch({
      token: () =>
        jsonResponse(200, {
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value',
          scope: 'offline_access openid profile',
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

  it('rejects a grant missing Mail.Send', async () => {
    const fake = createFakeStore();
    const { fetchImpl } = createFakeFetch({
      token: () =>
        jsonResponse(200, {
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value',
          scope: 'Mail.ReadWrite offline_access openid profile',
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

  it('rejects an invalid state before contacting Microsoft', async () => {
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
});

describe('Microsoft access token refresh', () => {
  it('refreshes on the tenant carried by the mailbox', async () => {
    const fake = createFakeStore(PINNED_MAILBOX);
    fake.store.getActiveRefreshToken = () =>
      Promise.resolve(encryptToken('refresh-token-value', KEYRING));
    const { fetchImpl, calls } = createFakeFetch({
      token: () => jsonResponse(200, { access_token: 'access-token-value', expires_in: 3599 }),
    });
    const service = createService(fake, fetchImpl);

    const token = await service.getAccessToken(PINNED_MAILBOX.id, CORRELATION_ID);
    expect(token.accessToken).toBe('access-token-value');
    expect(calls[0]?.url).toBe(
      'https://login.microsoftonline.com/other-tenant-id/oauth2/v2.0/token',
    );
    expect(fake.refreshed).toEqual([PINNED_MAILBOX.id]);
  });

  it('refreshes on the default tenant when the mailbox pins none', async () => {
    const fake = createFakeStore();
    fake.store.getActiveRefreshToken = () =>
      Promise.resolve(encryptToken('refresh-token-value', KEYRING));
    const { fetchImpl, calls } = createFakeFetch({
      token: () => jsonResponse(200, { access_token: 'access-token-value', expires_in: 3599 }),
    });
    const service = createService(fake, fetchImpl);

    await service.getAccessToken(MAILBOX.id, CORRELATION_ID);
    expect(calls[0]?.url).toBe('https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token');
  });

  it('marks the connection revoked when Microsoft reports invalid_grant', async () => {
    const fake = createFakeStore();
    fake.store.getActiveRefreshToken = () =>
      Promise.resolve(encryptToken('refresh-token-value', KEYRING));
    const { fetchImpl, calls } = createFakeFetch({
      token: () => jsonResponse(400, { error: 'invalid_grant' }),
    });
    const service = createService(fake, fetchImpl);

    await expectGatewayError(service.getAccessToken(MAILBOX.id, CORRELATION_ID), 'TOKEN_REVOKED');
    expect(fake.revoked).toEqual([MAILBOX.id]);
    const body = requestBody(calls[0]?.init);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-token-value');
    expect(body).toContain('client_secret=client-secret-value');
  });

  it('never requests scopes beyond the stored grant', async () => {
    const fake = createFakeStore();
    fake.store.getActiveRefreshToken = () =>
      Promise.resolve(encryptToken('refresh-token-value', KEYRING));
    const { fetchImpl, calls } = createFakeFetch({
      token: () => jsonResponse(200, { access_token: 'access-token-value', expires_in: 3599 }),
    });
    const service = createService(fake, fetchImpl);

    await service.getAccessToken(MAILBOX.id, CORRELATION_ID);

    // The configured set is wider than the grant of a mailbox connected before
    // Mail.Send existed, so the refresh must not name scopes at all.
    expect(MICROSOFT_GRAPH_SCOPES).toContain('https://graph.microsoft.com/Mail.Send');
    const body = new URLSearchParams(requestBody(calls[0]?.init));
    expect(body.has('scope')).toBe(false);
  });

  it('reports the AADSTS description and codes behind invalid_grant', async () => {
    const fake = createFakeStore();
    fake.store.getActiveRefreshToken = () =>
      Promise.resolve(encryptToken('refresh-token-value', KEYRING));
    const { fetchImpl } = createFakeFetch({
      token: () =>
        jsonResponse(400, {
          error: 'invalid_grant',
          error_description:
            'AADSTS65001: The user or administrator has not consented to use the application.',
          error_codes: [65001],
        }),
    });
    const service = createService(fake, fetchImpl);

    const error = await expectGatewayError(
      service.getAccessToken(MAILBOX.id, CORRELATION_ID),
      'TOKEN_REVOKED',
    );
    expect(error.message).toContain('invalid_grant');
    expect(error.message).toContain('error_codes 65001');
    expect(error.message).toContain('has not consented');
  });
});

describe('Microsoft identity from id_token', () => {
  function fakeIdToken(claims: Record<string, unknown>): string {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    return `${encode({ alg: 'RS256' })}.${encode(claims)}.fake-signature`;
  }

  it('extracts preferred_username and falls back through email and upn', async () => {
    const { identityFromIdToken } = await import('../../packages/oauth/src/microsoft.js');
    expect(identityFromIdToken(fakeIdToken({ preferred_username: 'hello@corp.example.com' }))).toBe(
      'hello@corp.example.com',
    );
    expect(identityFromIdToken(fakeIdToken({ email: 'hello@corp.example.com' }))).toBe(
      'hello@corp.example.com',
    );
    expect(identityFromIdToken(fakeIdToken({ upn: 'hello@corp.example.com' }))).toBe(
      'hello@corp.example.com',
    );
    expect(identityFromIdToken(fakeIdToken({ preferred_username: 'not-an-address' }))).toBe(
      undefined,
    );
    expect(identityFromIdToken(undefined)).toBe(undefined);
    expect(identityFromIdToken('garbage')).toBe(undefined);
  });
});
