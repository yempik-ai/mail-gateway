import { describe, expect, it } from 'vitest';
import { GatewayError, type AccessTokenProvider } from '../../packages/core/src/index.js';
import { createGmailAdapter } from '../../packages/gmail-adapter/src/index.js';

const MAILBOX_ID = 'primary-gmail';
const CORRELATION_ID = 'gmail-send-as-correlation-id';

function createAdapter(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const resolvedInit = init ?? {};
    calls.push({ url, init: resolvedInit });
    return Promise.resolve(handler(url, resolvedInit));
  }) as typeof fetch;
  const tokenProvider: AccessTokenProvider = {
    getAccessToken() {
      return Promise.resolve({ accessToken: 'fresh-access-token' });
    },
  };
  const adapter = createGmailAdapter({
    mailboxId: MAILBOX_ID,
    emailAddress: 'outreach@example.com',
    correlationId: CORRELATION_ID,
    tokenProvider,
    fetchImpl,
  });
  return { adapter, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Gmail send-as identities', () => {
  it('reads settings.sendAs with the mailbox token and maps every identity', async () => {
    const { adapter, calls } = createAdapter(() =>
      jsonResponse(200, {
        sendAs: [
          {
            sendAsEmail: 'outreach@example.com',
            displayName: 'Alex Morgan',
            signature: '<div>Alex<br>Example</div>',
            isPrimary: true,
            isDefault: true,
          },
          {
            sendAsEmail: ' Hello@Example.com ',
            displayName: '',
            signature: '',
            isDefault: false,
          },
          { displayName: 'No address is skipped' },
        ],
      }),
    );

    const identities = await adapter.listSendingIdentities();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.toString()).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs',
    );
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.headers).toEqual({ authorization: 'Bearer fresh-access-token' });
    expect(identities).toEqual([
      {
        emailAddress: 'outreach@example.com',
        displayName: 'Alex Morgan',
        signatureHtml: '<div>Alex<br>Example</div>',
        isPrimary: true,
      },
      // An empty signature or display name is "none", not an empty value.
      { emailAddress: 'Hello@Example.com', isPrimary: false },
    ]);
  });

  it('returns no identities when Gmail lists none', async () => {
    const { adapter } = createAdapter(() => jsonResponse(200, {}));
    await expect(adapter.listSendingIdentities()).resolves.toEqual([]);
  });

  it('maps a revoked token to a gateway error', async () => {
    const { adapter } = createAdapter(() =>
      jsonResponse(401, { error: { code: 401, message: 'Invalid Credentials' } }),
    );

    const error = await adapter.listSendingIdentities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).correlationId).toBe(CORRELATION_ID);
  });
});
