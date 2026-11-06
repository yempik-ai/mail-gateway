import { describe, expect, it } from 'vitest';
import { GatewayError, type AccessTokenProvider } from '../../packages/core/src/index.js';
import { createGmailAdapter } from '../../packages/gmail-adapter/src/index.js';
import { requestUrl } from '../support/fetch.js';

const MAILBOX_ID = 'primary-gmail';
const EMAIL_ADDRESS = 'outreach@example.com';
const CORRELATION_ID = 'gmail-adapter-correlation-id';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

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

function messageFixture(options: {
  id: string;
  threadId?: string;
  receivedAt: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  labels?: string[];
  includeBodies?: boolean;
}): Record<string, unknown> {
  const headers = [
    { name: 'From', value: options.from ?? 'Alice Example <alice@example.com>' },
    {
      name: 'To',
      value: options.to ?? '"Example, Outreach" <outreach@example.com>, bob@example.com',
    },
    { name: 'Cc', value: options.cc ?? 'Carol Example <carol@example.com>' },
    { name: 'Reply-To', value: 'replies@example.com' },
    { name: 'Subject', value: options.subject ?? 'Re: Product conversation' },
    { name: 'Date', value: 'Fri, 7 Aug 2026 10:15:00 +0200' },
    { name: 'Message-ID', value: `<${options.id}@example.com>` },
    { name: 'In-Reply-To', value: '<original@example.com>' },
    { name: 'References', value: '<first@example.com> <original@example.com>' },
  ];
  const parts = options.includeBodies
    ? [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: base64Url('Hello from plain text · ✓') } },
            {
              mimeType: 'text/html',
              body: { data: base64Url('<p>Hello from <strong>HTML</strong></p>') },
            },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'proposal.pdf',
          body: { attachmentId: 'opaque-attachment-id', size: 1234 },
        },
      ]
    : [];

  return {
    id: options.id,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    labelIds: options.labels ?? ['INBOX', 'UNREAD', 'IMPORTANT'],
    snippet: 'A concise Gmail snippet',
    internalDate: String(Date.parse(options.receivedAt)),
    payload: {
      mimeType: options.includeBodies ? 'multipart/mixed' : 'text/plain',
      headers,
      body: options.includeBodies ? {} : { size: 0 },
      parts,
    },
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
  return createGmailAdapter({
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

describe('Gmail message normalization', () => {
  it('normalizes nested multipart bodies, headers, addresses, labels, and attachment metadata', async () => {
    const fixture = messageFixture({
      id: 'message-1',
      threadId: 'thread-1',
      receivedAt: '2026-08-07T08:16:30.000Z',
      includeBodies: true,
    });
    const { fetchImpl, calls } = createFakeFetch((url) => {
      expect(url.pathname).toBe('/gmail/v1/users/me/messages/message-1');
      expect(url.searchParams.get('format')).toBe('full');
      return jsonResponse(200, fixture);
    });

    const email = await createAdapter(fetchImpl).getEmail('message-1', { includeBody: true });

    expect(email).toEqual({
      mailboxId: MAILBOX_ID,
      provider: 'gmail',
      messageId: 'message-1',
      threadId: 'thread-1',
      internetMessageId: '<message-1@example.com>',
      from: { name: 'Alice Example', address: 'alice@example.com' },
      replyTo: [{ address: 'replies@example.com' }],
      to: [
        { name: 'Example, Outreach', address: 'outreach@example.com' },
        { address: 'bob@example.com' },
      ],
      cc: [{ name: 'Carol Example', address: 'carol@example.com' }],
      subject: 'Re: Product conversation',
      snippet: 'A concise Gmail snippet',
      textBody: 'Hello from plain text · ✓',
      htmlBody: '<p>Hello from <strong>HTML</strong></p>',
      receivedAt: '2026-08-07T08:16:30.000Z',
      sentAt: '2026-08-07T08:15:00.000Z',
      isRead: false,
      isDraft: false,
      hasAttachments: true,
      folderIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
      labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
      inReplyTo: '<original@example.com>',
      references: ['<first@example.com>', '<original@example.com>'],
      providerWebUrl: 'https://mail.google.com/mail/u/0/#all/message-1',
    });
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toEqual({ authorization: 'Bearer fresh-access-token' });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('searches with pagination and fetches metadata without bodies', async () => {
    const tokenCalls: string[] = [];
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (url.pathname === '/gmail/v1/users/me/messages') {
        expect(url.searchParams.get('q')).toBe('from:alice@example.com in:inbox');
        expect(url.searchParams.get('maxResults')).toBe('100');
        expect(url.searchParams.get('pageToken')).toBe('page-one');
        return jsonResponse(200, {
          messages: [{ id: 'metadata-message' }],
          nextPageToken: 'page-two',
        });
      }
      expect(url.pathname).toBe('/gmail/v1/users/me/messages/metadata-message');
      expect(url.searchParams.get('format')).toBe('metadata');
      expect(url.searchParams.getAll('metadataHeaders')).toContain('Message-ID');
      return jsonResponse(
        200,
        messageFixture({
          id: 'metadata-message',
          receivedAt: '2026-08-07T08:16:30.000Z',
        }),
      );
    });

    const result = await createAdapter(fetchImpl, tokenCalls).searchEmails({
      from: 'alice@example.com',
      folder: 'inbox',
      limit: 500,
      cursor: 'page-one',
    });

    expect(result.nextCursor).toBe('page-two');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.textBody).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(tokenCalls).toEqual([
      `${MAILBOX_ID}:${CORRELATION_ID}`,
      `${MAILBOX_ID}:${CORRELATION_ID}`,
    ]);
  });
});

describe('Gmail thread normalization', () => {
  it('sorts messages chronologically and deduplicates participants by address', async () => {
    const newer = messageFixture({
      id: 'newer',
      threadId: 'thread-1',
      receivedAt: '2026-08-07T12:00:00.000Z',
      from: 'Bob Example <BOB@example.com>',
      to: 'outreach@example.com',
      cc: '',
      subject: 'Re: Thread subject',
      labels: ['INBOX'],
      includeBodies: true,
    });
    const older = messageFixture({
      id: 'older',
      threadId: 'thread-1',
      receivedAt: '2026-08-06T09:00:00.000Z',
      from: 'Example <outreach@example.com>',
      to: 'Bob Example <bob@example.com>',
      cc: '',
      subject: 'Thread subject',
      labels: ['SENT'],
      includeBodies: true,
    });
    const { fetchImpl } = createFakeFetch((url) => {
      expect(url.toString()).toBe(`${API_BASE}/threads/thread-1?format=full`);
      return jsonResponse(200, { id: 'thread-1', messages: [newer, older] });
    });

    const thread = await createAdapter(fetchImpl).getThread('thread-1');

    expect(thread.messages.map((message) => message.messageId)).toEqual(['older', 'newer']);
    expect(thread.subject).toBe('Thread subject');
    expect(thread.participants).toEqual([
      { name: 'Example', address: 'outreach@example.com' },
      { name: 'Bob Example', address: 'bob@example.com' },
    ]);
    expect(thread.lastActivityAt).toBe('2026-08-07T12:00:00.000Z');
  });
});

describe('Gmail adapter error mapping', () => {
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
});
