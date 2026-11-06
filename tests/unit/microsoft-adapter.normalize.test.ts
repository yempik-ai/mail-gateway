import { describe, expect, it } from 'vitest';
import { GatewayError, type AccessTokenProvider } from '../../packages/core/src/index.js';
import { createMicrosoftAdapter } from '../../packages/microsoft-adapter/src/index.js';
import { requestUrl } from '../support/fetch.js';

const MAILBOX_ID = 'sales-outlook';
const EMAIL_ADDRESS = 'outreach@corp.example.com';
const CORRELATION_ID = 'microsoft-adapter-correlation-id';
const API_BASE = 'https://graph.microsoft.com/v1.0';

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function recipient(name: string | undefined, address: string): Record<string, unknown> {
  return {
    emailAddress: {
      ...(name === undefined ? {} : { name }),
      address,
    },
  };
}

function messageFixture(options: {
  id: string;
  conversationId?: string;
  receivedAt: string;
  subject?: string;
  fromName?: string;
  fromAddress?: string;
  to?: Record<string, unknown>[];
  body?: { contentType: 'text' | 'html'; content: string };
}): Record<string, unknown> {
  return {
    id: options.id,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    internetMessageId: `<${options.id}@example.com>`,
    subject: options.subject ?? 'Re: Product conversation',
    bodyPreview: 'A concise Graph snippet',
    ...(options.body === undefined ? {} : { body: options.body }),
    from: recipient(
      options.fromName ?? 'Alice Example',
      options.fromAddress ?? 'alice@example.com',
    ),
    sender: recipient('Delegated Sender', 'delegate@example.com'),
    toRecipients: options.to ?? [
      recipient('Example Outreach', 'outreach@corp.example.com'),
      recipient(undefined, 'bob@example.com'),
    ],
    ccRecipients: [recipient('Carol Example', 'carol@example.com')],
    replyTo: [recipient(undefined, 'responses@example.com')],
    isRead: false,
    isDraft: false,
    hasAttachments: true,
    receivedDateTime: options.receivedAt,
    sentDateTime: '2026-08-07T08:15:00.000Z',
    webLink: `https://outlook.office.com/mail/deeplink/read/${options.id}`,
    categories: ['Customer', 'Important'],
    parentFolderId: 'inbox-folder-id',
  };
}

function createFakeFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push(init === undefined ? { url: url.toString() } : { url: url.toString(), init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function createAdapter(fetchImpl: typeof fetch, tokenCalls: string[] = []) {
  const tokenProvider: AccessTokenProvider = {
    getAccessToken(mailboxId, correlationId) {
      tokenCalls.push(`${mailboxId}:${correlationId}`);
      return Promise.resolve({ accessToken: 'fresh-access-token' });
    },
  };
  return createMicrosoftAdapter({
    mailboxId: MAILBOX_ID,
    emailAddress: EMAIL_ADDRESS,
    correlationId: CORRELATION_ID,
    tokenProvider,
    fetchImpl,
  });
}

async function expectGatewayError(promise: Promise<unknown>, code: string): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const result = error as GatewayError;
    expect(result.code).toBe(code);
    expect(result.correlationId).toBe(CORRELATION_ID);
    return result;
  }
  throw new Error(`Expected GatewayError ${code}`);
}

describe('Microsoft message normalization', () => {
  it('normalizes an HTML message, recipients, categories, and folder metadata', async () => {
    const fixture = messageFixture({
      id: 'message-1',
      conversationId: 'conversation-1',
      receivedAt: '2026-08-07T08:16:30.000Z',
      body: { contentType: 'html', content: '<p>Hello from <strong>Graph</strong></p>' },
    });
    const { fetchImpl, calls } = createFakeFetch((url) => {
      expect(url.pathname).toBe('/v1.0/me/messages/message-1');
      expect(url.searchParams.get('$select')).toContain('body,uniqueBody');
      return jsonResponse(200, fixture);
    });

    const email = await createAdapter(fetchImpl).getEmail('message-1');

    expect(email).toEqual({
      mailboxId: MAILBOX_ID,
      provider: 'microsoft',
      messageId: 'message-1',
      threadId: 'conversation-1',
      conversationId: 'conversation-1',
      internetMessageId: '<message-1@example.com>',
      from: { name: 'Alice Example', address: 'alice@example.com' },
      replyTo: [{ address: 'responses@example.com' }],
      to: [
        { name: 'Example Outreach', address: 'outreach@corp.example.com' },
        { address: 'bob@example.com' },
      ],
      cc: [{ name: 'Carol Example', address: 'carol@example.com' }],
      subject: 'Re: Product conversation',
      snippet: 'A concise Graph snippet',
      htmlBody: '<p>Hello from <strong>Graph</strong></p>',
      receivedAt: '2026-08-07T08:16:30.000Z',
      sentAt: '2026-08-07T08:15:00.000Z',
      isRead: false,
      isDraft: false,
      hasAttachments: true,
      folderIds: ['inbox-folder-id'],
      labelIds: ['Customer', 'Important'],
      references: [],
      providerWebUrl: 'https://outlook.office.com/mail/deeplink/read/message-1',
    });
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toEqual({ authorization: 'Bearer fresh-access-token' });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('round-trips a Graph next link through the opaque cursor', async () => {
    const nextLink = `${API_BASE}/me/messages?$skiptoken=opaque-page-two`;
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (calls.length === 1) {
        expect(url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
        expect(url.searchParams.get('$top')).toBe('100');
        expect(url.searchParams.get('$filter')).toBe(
          "from/emailAddress/address eq 'alice@example.com'",
        );
        expect(url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
        expect(url.searchParams.get('$select')?.split(',')).not.toContain('body');
        return jsonResponse(200, {
          value: [
            messageFixture({
              id: 'summary-message',
              receivedAt: '2026-08-07T08:16:30.000Z',
            }),
          ],
          '@odata.nextLink': nextLink,
        });
      }
      expect(url.toString()).toBe(nextLink);
      return jsonResponse(200, { value: [] });
    });
    const adapter = createAdapter(fetchImpl);

    const firstPage = await adapter.searchEmails({
      from: 'alice@example.com',
      folder: 'inbox',
      limit: 500,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]?.htmlBody).toBeUndefined();
    expect(firstPage.nextCursor).toBe(base64Url(nextLink));

    const secondPage = await adapter.searchEmails({ cursor: firstPage.nextCursor ?? '' });
    expect(secondPage).toEqual({ items: [] });
    expect(calls).toHaveLength(2);
  });
});

describe('Microsoft conversation normalization', () => {
  it('sorts messages chronologically, uses the newest subject, and deduplicates participants', async () => {
    const newer = messageFixture({
      id: 'newer',
      conversationId: 'conversation-1',
      receivedAt: '2026-08-07T12:00:00.000Z',
      subject: 'Re: Updated thread subject',
      fromName: 'Bob Example',
      fromAddress: 'BOB@example.com',
      to: [recipient(undefined, 'outreach@corp.example.com')],
      body: { contentType: 'text', content: 'Newer reply' },
    });
    const older = messageFixture({
      id: 'older',
      conversationId: 'conversation-1',
      receivedAt: '2026-08-06T09:00:00.000Z',
      subject: 'Original subject',
      fromName: 'Example',
      fromAddress: 'outreach@corp.example.com',
      to: [recipient('Bob Example', 'bob@example.com')],
      body: { contentType: 'text', content: 'Original message' },
    });
    const { fetchImpl } = createFakeFetch((url) => {
      expect(url.pathname).toBe('/v1.0/me/messages');
      expect(url.searchParams.get('$filter')).toBe("conversationId eq 'conversation-1'");
      expect(url.searchParams.get('$orderby')).toBe('receivedDateTime asc');
      expect(url.searchParams.get('$top')).toBe('100');
      return jsonResponse(200, { value: [newer, older] });
    });

    const thread = await createAdapter(fetchImpl).getThread('conversation-1');

    expect(thread.messages.map((message) => message.messageId)).toEqual(['older', 'newer']);
    expect(thread.subject).toBe('Re: Updated thread subject');
    expect(thread.participants.slice(0, 2)).toEqual([
      { name: 'Example', address: 'outreach@corp.example.com' },
      { name: 'Bob Example', address: 'bob@example.com' },
    ]);
    expect(
      thread.participants.filter((item) => item.address.toLowerCase() === 'bob@example.com'),
    ).toHaveLength(1);
    expect(thread.lastActivityAt).toBe('2026-08-07T12:00:00.000Z');
  });
});

describe('Microsoft adapter error mapping', () => {
  it('maps 401 responses to TOKEN_EXPIRED', async () => {
    const { fetchImpl } = createFakeFetch(() => jsonResponse(401, { error: 'invalid token' }));
    const error = await expectGatewayError(
      createAdapter(fetchImpl).getEmail('message-1'),
      'TOKEN_EXPIRED',
    );
    expect(error.retryable).toBe(false);
  });

  it('maps a missing message to MESSAGE_NOT_FOUND', async () => {
    const { fetchImpl } = createFakeFetch(() => jsonResponse(404, { error: 'not found' }));
    const error = await expectGatewayError(
      createAdapter(fetchImpl).getEmail('missing-message'),
      'MESSAGE_NOT_FOUND',
    );
    expect(error.retryable).toBe(false);
  });

  it('maps 429 responses and preserves Retry-After', async () => {
    const { fetchImpl } = createFakeFetch(() =>
      jsonResponse(429, { error: 'rate limited' }, { 'retry-after': '45' }),
    );
    const error = await expectGatewayError(
      createAdapter(fetchImpl).getEmail('message-1'),
      'PROVIDER_RATE_LIMIT',
    );
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(45);
  });

  it('rejects a decoded cursor outside the Graph host', async () => {
    const { fetchImpl, calls } = createFakeFetch(() => jsonResponse(200, { value: [] }));
    const tokenCalls: string[] = [];
    const error = await expectGatewayError(
      createAdapter(fetchImpl, tokenCalls).searchEmails({
        cursor: base64Url('https://graph.microsoft.com.attacker.example/v1.0/me/messages'),
      }),
      'INVALID_QUERY',
    );
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(0);
    expect(tokenCalls).toHaveLength(0);
  });
});
