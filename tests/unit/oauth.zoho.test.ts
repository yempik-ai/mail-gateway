import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../packages/core/src/index.js';
import { decryptToken, encryptToken, loadTokenKeyring } from '../../packages/security/src/index.js';
import {
  createOAuthState,
  createZohoOAuthService,
  ZOHO_MAIL_SCOPES,
  ZOHO_REFRESH_TOKEN_KIND,
  type CompleteConnectionInput,
  type OAuthMailbox,
  type OAuthStore,
} from '../../packages/oauth/src/index.js';
import { requestBody, requestUrl } from '../support/fetch.js';

const STATE_SECRET = 'a-state-secret-longer-than-sixteen';
const KEYRING = loadTokenKeyring('{"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}', 1);
const REDIRECT_URI = 'https://mail.corp.example.com/oauth/zoho/callback';
const CORRELATION_ID = '3f1e9f7a-0000-4000-8000-000000000001';
const MAILBOX: OAuthMailbox = {
  id: 'team-zoho',
  provider: 'zoho',
  emailAddress: 'outreach@zoho.example.com',
  enabled: true,
  microsoftTenantId: null,
};
const GRANTED_SCOPE = ZOHO_MAIL_SCOPES.join(',');

interface FakeStore {
  store: OAuthStore;
  completed: CompleteConnectionInput[];
  errors: { mailboxId: string; errorCode: string }[];
  revoked: string[];
}

function createFakeStore(refreshToken?: string): FakeStore {
  const completed: CompleteConnectionInput[] = [];
  const errors: { mailboxId: string; errorCode: string }[] = [];
  const revoked: string[] = [];
  return {
    completed,
    errors,
    revoked,
    store: {
      getMailbox: (mailboxId) => Promise.resolve(mailboxId === MAILBOX.id ? MAILBOX : undefined),
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
      getActiveRefreshToken: () =>
        Promise.resolve(
          refreshToken === undefined ? undefined : encryptToken(refreshToken, KEYRING),
        ),
      markTokenRefreshed: () => Promise.resolve(),
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createService(
  store: OAuthStore,
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(requestUrl(input), init)) as typeof fetch;
  return createZohoOAuthService({
    clientId: 'zoho-client-id',
    clientSecret: 'zoho-client-secret',
    region: 'eu',
    redirectUri: REDIRECT_URI,
    stateSecret: STATE_SECRET,
    keyring: KEYRING,
    store,
    fetchImpl,
  });
}

function tokenSuccess(): Record<string, unknown> {
  return {
    access_token: 'zoho-access-token',
    refresh_token: 'zoho-refresh-token',
    scope: GRANTED_SCOPE,
    expires_in: 3600,
  };
}

function accountsSuccess(address = MAILBOX.emailAddress): Record<string, unknown> {
  return { data: [{ accountId: '8000000', primaryEmailAddress: address }] };
}

async function expectGatewayError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected GatewayError ${code}`);
}

describe('Zoho authorization URL', () => {
  it('targets the regional accounts host and asks for an offline grant', async () => {
    const { store } = createFakeStore();
    const service = createService(store, () => jsonResponse(200, {}));
    const url = new URL(await service.authorizationUrl(MAILBOX.id, CORRELATION_ID));

    expect(url.origin).toBe('https://accounts.zoho.eu');
    expect(url.pathname).toBe('/oauth/v2/auth');
    // Zoho only issues a refresh token when both parameters are present.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    // Zoho separates scopes with commas, unlike the OAuth default.
    expect(url.searchParams.get('scope')).toBe(ZOHO_MAIL_SCOPES.join(','));
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('refuses a mailbox that belongs to another provider', async () => {
    const { store } = createFakeStore();
    const service = createService(store, () => jsonResponse(200, {}));
    await expectGatewayError(
      service.authorizationUrl('sales-outlook', CORRELATION_ID),
      'MAILBOX_NOT_FOUND',
    );
  });
});

describe('Zoho callback', () => {
  const state = () => createOAuthState(MAILBOX.id, STATE_SECRET);

  it('stores the encrypted refresh token once the identity matches', async () => {
    const fake = createFakeStore();
    const service = createService(fake.store, (url) =>
      url.pathname === '/oauth/v2/token'
        ? jsonResponse(200, tokenSuccess())
        : jsonResponse(200, accountsSuccess()),
    );

    const result = await service.handleCallback(
      { code: 'auth-code', state: state() },
      CORRELATION_ID,
    );

    expect(result.emailAddress).toBe(MAILBOX.emailAddress);
    expect(fake.completed).toHaveLength(1);
    const [completed] = fake.completed;
    expect(completed?.tokenKind).toBe(ZOHO_REFRESH_TOKEN_KIND);
    expect(completed?.provider).toBe('zoho');
    expect(decryptToken(completed!.encryptedRefreshToken, KEYRING)).toBe('zoho-refresh-token');
  });

  it('treats an HTTP 200 carrying an error field as a failure', async () => {
    const fake = createFakeStore();
    const service = createService(fake.store, () => jsonResponse(200, { error: 'invalid_client' }));
    await expectGatewayError(
      service.handleCallback({ code: 'auth-code', state: state() }, CORRELATION_ID),
      'AUTH_REQUIRED',
    );
    expect(fake.completed).toHaveLength(0);
  });

  it('rejects a grant that is missing a required scope', async () => {
    const fake = createFakeStore();
    const service = createService(fake.store, (url) =>
      url.pathname === '/oauth/v2/token'
        ? jsonResponse(200, { ...tokenSuccess(), scope: 'ZohoMail.messages.READ' })
        : jsonResponse(200, accountsSuccess()),
    );
    await expectGatewayError(
      service.handleCallback({ code: 'auth-code', state: state() }, CORRELATION_ID),
      'AUTH_REQUIRED',
    );
    expect(fake.completed).toHaveLength(0);
  });

  it('rejects a consent given on a different Zoho account', async () => {
    const fake = createFakeStore();
    const service = createService(fake.store, (url) =>
      url.pathname === '/oauth/v2/token'
        ? jsonResponse(200, tokenSuccess())
        : jsonResponse(200, accountsSuccess('someone-else@zoho.example.com')),
    );

    await expectGatewayError(
      service.handleCallback({ code: 'auth-code', state: state() }, CORRELATION_ID),
      'MAILBOX_MISMATCH',
    );
    expect(fake.errors).toEqual([{ mailboxId: MAILBOX.id, errorCode: 'MAILBOX_MISMATCH' }]);
    expect(fake.completed).toHaveLength(0);
  });

  it('refuses a tampered state', async () => {
    const fake = createFakeStore();
    const service = createService(fake.store, () => jsonResponse(200, tokenSuccess()));
    await expectGatewayError(
      service.handleCallback({ code: 'auth-code', state: 'not-a-state' }, CORRELATION_ID),
      'AUTH_REQUIRED',
    );
  });
});

describe('Zoho access tokens', () => {
  it('refreshes without sending a scope parameter', async () => {
    const fake = createFakeStore('stored-refresh-token');
    let body: URLSearchParams | undefined;
    const service = createService(fake.store, (_url, init) => {
      body = new URLSearchParams(requestBody(init));
      return jsonResponse(200, { access_token: 'fresh-token', expires_in: 3600 });
    });

    const token = await service.getAccessToken(MAILBOX.id, CORRELATION_ID);

    expect(token.accessToken).toBe('fresh-token');
    expect(body?.get('grant_type')).toBe('refresh_token');
    expect(body?.get('refresh_token')).toBe('stored-refresh-token');
  });

  it('marks the connection revoked when Zoho rejects the refresh token', async () => {
    const fake = createFakeStore('stored-refresh-token');
    const service = createService(fake.store, () => jsonResponse(200, { error: 'invalid_grant' }));

    await expectGatewayError(service.getAccessToken(MAILBOX.id, CORRELATION_ID), 'TOKEN_REVOKED');
    expect(fake.revoked).toEqual([MAILBOX.id]);
  });

  it('reports a mailbox that was never connected', async () => {
    const fake = createFakeStore();
    const service = createService(fake.store, () => jsonResponse(200, tokenSuccess()));
    await expectGatewayError(service.getAccessToken(MAILBOX.id, CORRELATION_ID), 'AUTH_REQUIRED');
  });
});
