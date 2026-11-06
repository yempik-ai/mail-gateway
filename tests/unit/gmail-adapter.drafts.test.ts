import { describe, expect, it } from 'vitest';
import { GatewayError, type AccessTokenProvider } from '../../packages/core/src/index.js';
import { createGmailAdapter } from '../../packages/gmail-adapter/src/index.js';
import { requestBody, requestUrl } from '../support/fetch.js';

const MAILBOX_ID = 'primary-gmail';
const EMAIL_ADDRESS = 'outreach@example.com';
const CORRELATION_ID = 'gmail-drafts-correlation-id';

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

interface DraftRequestBody {
  message: {
    raw: string;
    threadId?: string;
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function metadataMessage(options: {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  replyTo?: string;
  to?: string;
  cc?: string;
  messageId?: string;
  references?: string;
}): Record<string, unknown> {
  const headers = [
    { name: 'Subject', value: options.subject ?? 'Existing subject' },
    { name: 'From', value: options.from ?? 'Alice <alice@example.com>' },
    { name: 'To', value: options.to ?? EMAIL_ADDRESS },
    { name: 'Cc', value: options.cc ?? '' },
    { name: 'Message-ID', value: options.messageId ?? '<source@example.com>' },
    { name: 'References', value: options.references ?? '<first@example.com>' },
    ...(options.replyTo === undefined ? [] : [{ name: 'Reply-To', value: options.replyTo }]),
  ];
  return {
    id: options.id,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    payload: { headers },
  };
}

/** A `format=full` source message: the metadata headers plus both body parts. */
function fullMessage(options: {
  id: string;
  threadId?: string;
  from?: string;
  date?: string;
  internalDate?: string;
  textBody?: string;
  htmlBody?: string;
}): Record<string, unknown> {
  const metadata = metadataMessage({
    id: options.id,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    ...(options.from === undefined ? {} : { from: options.from }),
  });
  const payload = metadata.payload as { headers: { name: string; value: string }[] };
  const part = (mimeType: string, content: string) => ({
    mimeType,
    body: { data: Buffer.from(content, 'utf8').toString('base64url') },
  });
  return {
    ...metadata,
    ...(options.internalDate === undefined ? {} : { internalDate: options.internalDate }),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        ...payload.headers,
        ...(options.date === undefined ? [] : [{ name: 'Date', value: options.date }]),
      ],
      parts: [
        ...(options.textBody === undefined ? [] : [part('text/plain', options.textBody)]),
        ...(options.htmlBody === undefined ? [] : [part('text/html', options.htmlBody)]),
      ],
    },
  };
}

/** Decodes every quoted-printable part of a raw MIME message back to UTF-8 text. */
function decodedMime(mime: string): string {
  const unfolded = mime.replace(/=\r\n/gu, '');
  return Buffer.from(
    unfolded.replace(/=([0-9A-F]{2})/gu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ),
    'latin1',
  ).toString('utf8');
}

function createFakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const resolvedInit = init ?? {};
    calls.push({ url: url.toString(), init: resolvedInit });
    return handler(url, resolvedInit);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function createAdapter(fetchImpl: typeof fetch, aliases: string[] = []) {
  const tokenProvider: AccessTokenProvider = {
    getAccessToken() {
      return Promise.resolve({ accessToken: 'fresh-access-token' });
    },
  };
  return createGmailAdapter({
    mailboxId: MAILBOX_ID,
    emailAddress: EMAIL_ADDRESS,
    aliases,
    correlationId: CORRELATION_ID,
    tokenProvider,
    fetchImpl,
  });
}

function requestJson(init: RequestInit): DraftRequestBody {
  expect(typeof init.body).toBe('string');
  return JSON.parse(requestBody(init)) as DraftRequestBody;
}

function decodedRaw(init: RequestInit): string {
  const body = requestJson(init);
  return Buffer.from(String(body.message.raw), 'base64url').toString('utf8');
}

async function expectGatewayError(promise: Promise<unknown>, code: string): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.code).toBe(code);
    expect(gatewayError.correlationId).toBe(CORRELATION_ID);
    return gatewayError;
  }
  throw new Error(`Expected GatewayError ${code}`);
}

describe('Gmail draft creation', () => {
  it('creates a base64url MIME draft and maps the Gmail identifiers', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        authorization: 'Bearer fresh-access-token',
        'content-type': 'application/json',
      });
      return jsonResponse(200, {
        id: 'draft-1',
        message: { id: 'draft-message-1', threadId: 'thread-created' },
      });
    });

    const snapshot = await createAdapter(fetchImpl).createDraft({
      to: ['alice@example.com'],
      cc: ['copy@example.com'],
      from: 'alias@example.com',
      subject: 'Hello Alice',
      textBody: 'Plain body',
      htmlBody: '<p>HTML body</p>',
      replyTo: 'responses@example.com',
    });

    const mime = decodedRaw(calls[0]?.init ?? {});
    const body = requestJson(calls[0]?.init ?? {});
    expect(mime).toContain('To: alice@example.com\r\n');
    expect(mime).toContain('From: alias@example.com\r\n');
    expect(mime).toContain('Cc: copy@example.com\r\n');
    expect(mime).toContain('Reply-To: responses@example.com\r\n');
    expect(mime).toContain('Content-Type: multipart/alternative;');
    expect(body.message.threadId).toBeUndefined();
    expect(snapshot).toEqual({
      providerDraftId: 'draft-1',
      providerMessageId: 'draft-message-1',
      threadId: 'thread-created',
      providerWebUrl: 'https://mail.google.com/mail/u/0/#drafts/draft-message-1',
      subject: 'Hello Alice',
      to: ['alice@example.com'],
    });
  });

  it.each([
    ['Needs prefix', 'Re: Needs prefix'],
    ['Re: Already prefixed', 'Re: Already prefixed'],
  ])(
    'creates a reply-all draft with the correct subject for %s',
    async (sourceSubject, expected) => {
      const { fetchImpl, calls } = createFakeFetch((url, init) => {
        if (url.pathname.endsWith('/messages/source-message')) {
          // A reply with a body quotes the original, so the one source read is `full`.
          expect(url.searchParams.get('format')).toBe('full');
          return jsonResponse(
            200,
            metadataMessage({
              id: 'source-message',
              threadId: 'thread-1',
              subject: sourceSubject,
              from: 'Alice <alice@example.com>',
              replyTo: 'Replies <replies@example.com>',
              to: 'Example <OUTREACH@example.com>, Bob <bob@example.com>',
              cc: 'replies@example.com, Carol <carol@example.com>',
              messageId: '<source@example.com>',
              references: '<root@example.com>',
            }),
          );
        }
        expect(url.pathname).toBe('/gmail/v1/users/me/drafts');
        expect(init.method).toBe('POST');
        return jsonResponse(200, {
          id: 'reply-draft',
          message: { id: 'reply-message', threadId: 'thread-1' },
        });
      });

      await createAdapter(fetchImpl).createReplyDraft({
        sourceMessageId: 'source-message',
        replyMode: 'replyAll',
        textBody: 'Following up',
      });

      const mime = decodedRaw(calls[1]?.init ?? {});
      const body = requestJson(calls[1]?.init ?? {});
      expect(mime).toContain('To: replies@example.com, bob@example.com, carol@example.com\r\n');
      expect(mime).not.toContain(EMAIL_ADDRESS);
      expect(mime).toContain(`Subject: ${expected}\r\n`);
      expect(mime).toContain('In-Reply-To: <source@example.com>\r\n');
      expect(mime).toContain('References: <root@example.com> <source@example.com>\r\n');
      expect(body.message.threadId).toBe('thread-1');
    },
  );

  it('quotes the original below the new body in both parts and sends the display name', async () => {
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (url.pathname.endsWith('/messages/source-message')) {
        expect(url.searchParams.get('format')).toBe('full');
        return jsonResponse(
          200,
          fullMessage({
            id: 'source-message',
            threadId: 'thread-1',
            from: 'Alice Rossi <alice@example.com>',
            date: 'Mon, 2 Nov 2026 10:15:00 +0000',
            textBody: 'Can we talk?\nThanks',
            htmlBody: '<div dir="ltr">Can we talk?<br>Thanks</div>',
          }),
        );
      }
      return jsonResponse(200, { id: 'reply-draft', message: { id: 'reply-message' } });
    });

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: 'source-message',
      replyMode: 'reply',
      from: 'outreach@example.com',
      fromDisplayName: 'Alex Morgan',
      textBody: 'Sure, Thursday works.\n\n-- \nAlex',
      htmlBody: '<p>Sure, Thursday works.</p>',
      quoteTimeZone: 'Europe/Rome',
    });

    expect(calls).toHaveLength(2);
    const raw = decodedRaw(calls[1]?.init ?? {});
    const mime = decodedMime(raw);
    const attribution = 'On Mon, Nov 2, 2026 at 11:15 AM Alice Rossi <alice@example.com> wrote:';
    expect(raw).toContain('From: "Alex Morgan" <outreach@example.com>\r\n');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    expect(raw).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(mime).toContain(
      `Sure, Thursday works.\r\n\r\n-- \r\nAlex\r\n\r\n${attribution}\r\n> Can we talk?\r\n> Thanks`,
    );
    expect(mime).toContain('<p>Sure, Thursday works.</p><br><div class="gmail_quote">');
    expect(mime).toContain(
      'On Mon, Nov 2, 2026 at 11:15 AM Alice Rossi &lt;alice@example.com&gt; wrote:',
    );
    expect(mime).toContain(
      '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
        '<div dir="ltr">Can we talk?<br>Thanks</div></blockquote>',
    );
  });

  it('falls back to internalDate and keeps a single part when only text is supplied', async () => {
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (url.pathname.endsWith('/messages/source-message')) {
        return jsonResponse(
          200,
          fullMessage({
            id: 'source-message',
            from: 'alice@example.com',
            internalDate: String(Date.parse('2026-11-02T10:15:00Z')),
            htmlBody: '<p>Only html</p>',
          }),
        );
      }
      return jsonResponse(200, { id: 'reply-draft', message: { id: 'reply-message' } });
    });

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: 'source-message',
      replyMode: 'reply',
      textBody: 'Text only',
    });

    const raw = decodedRaw(calls[1]?.init ?? {});
    expect(raw).not.toContain('multipart/alternative');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(decodedMime(raw)).toContain(
      'Text only\r\n\r\nOn Mon, Nov 2, 2026 at 10:15 AM alice@example.com wrote:\r\n> Only html',
    );
  });

  it('quotes in html only when only html is supplied', async () => {
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (url.pathname.endsWith('/messages/source-message')) {
        return jsonResponse(200, fullMessage({ id: 'source-message', textBody: 'Plain original' }));
      }
      return jsonResponse(200, { id: 'reply-draft', message: { id: 'reply-message' } });
    });

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: 'source-message',
      replyMode: 'reply',
      htmlBody: '<p>Html only</p>',
    });

    const raw = decodedRaw(calls[1]?.init ?? {});
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
    expect(raw).not.toContain('Content-Type: text/plain');
    expect(decodedMime(raw)).toContain(
      'Alice &lt;alice@example.com&gt; wrote:<br></div>' +
        '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
        'Plain original</blockquote>',
    );
  });

  it.each([
    ['quoteOriginal is false', { textBody: 'No quote', quoteOriginal: false }],
    ['no body is supplied', {}],
  ])('reads only metadata and adds no quote when %s', async (_label, extra) => {
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (url.pathname.endsWith('/messages/source-message')) {
        expect(url.searchParams.get('format')).toBe('metadata');
        return jsonResponse(200, metadataMessage({ id: 'source-message' }));
      }
      return jsonResponse(200, { id: 'reply-draft', message: { id: 'reply-message' } });
    });

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: 'source-message',
      replyMode: 'reply',
      ...extra,
    });

    const mime = decodedMime(decodedRaw(calls[1]?.init ?? {}));
    expect(mime).not.toContain('wrote:');
    expect(mime).not.toContain('gmail_quote');
  });
});

describe('Gmail draft delivery', () => {
  it('sends only the existing provider draft id', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts/send');
      expect(init.method).toBe('POST');
      return jsonResponse(
        200,
        metadataMessage({
          id: 'sent-message-1',
          threadId: 'thread-1',
          messageId: '<sent-message@example.com>',
        }),
      );
    });

    await expect(createAdapter(fetchImpl).sendDraft('draft-1')).resolves.toEqual({
      providerMessageId: 'sent-message-1',
      threadId: 'thread-1',
      internetMessageId: '<sent-message@example.com>',
    });
    expect(JSON.parse(requestBody(calls[0]?.init))).toEqual({ id: 'draft-1' });
  });

  it('maps an unmapped definitive status to PROVIDER_REJECTED', async () => {
    const { fetchImpl } = createFakeFetch(() =>
      jsonResponse(409, { error: { message: 'draft already sent' } }),
    );

    const error = await expectGatewayError(
      createAdapter(fetchImpl).sendDraft('draft-1'),
      'PROVIDER_REJECTED',
    );
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('409');
  });
});

describe('Gmail draft lifecycle', () => {
  it('fetches metadata, preserves draft headers and thread, then fully replaces the raw message', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts/draft-update');
      if (init.method === 'GET') {
        expect(url.search).toBe('?format=metadata');
        return jsonResponse(200, {
          id: 'draft-update',
          message: metadataMessage({
            id: 'old-message',
            threadId: 'thread-update',
            subject: 'Old subject',
            to: 'Alice <alice@example.com>',
            cc: 'Copy <copy@example.com>',
            replyTo: 'responses@example.com',
            messageId: '<old-draft@example.com>',
            references: '<root@example.com>',
          }),
        });
      }
      expect(init.method).toBe('PUT');
      return jsonResponse(200, {
        id: 'draft-update',
        message: { id: 'new-message', threadId: 'thread-update' },
      });
    });

    const snapshot = await createAdapter(fetchImpl).updateDraft('draft-update', {
      to: ['new@example.com'],
      subject: 'Updated subject',
      htmlBody: '<p>Replacement</p>',
    });

    const mime = decodedRaw(calls[1]?.init ?? {});
    const body = requestJson(calls[1]?.init ?? {});
    expect(mime).toContain('To: new@example.com\r\n');
    expect(mime).toContain('Cc: copy@example.com\r\n');
    expect(mime).toContain('Reply-To: responses@example.com\r\n');
    expect(mime).toContain('Subject: Updated subject\r\n');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8\r\n');
    expect(body.message.threadId).toBe('thread-update');
    expect(snapshot.providerMessageId).toBe('new-message');
    expect(snapshot.subject).toBe('Updated subject');
  });

  it('re-quotes the original below a replaced body when quoteOriginalMessageId is set', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      if (url.pathname === '/gmail/v1/users/me/messages/source-message') {
        expect(url.searchParams.get('format')).toBe('full');
        return jsonResponse(
          200,
          fullMessage({
            id: 'source-message',
            from: 'Alice <alice@example.com>',
            date: '2026-11-02T10:15:00Z',
            textBody: 'Original question',
            htmlBody: '<p>Original question</p>',
          }),
        );
      }
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts/draft-update');
      if (init.method === 'GET') {
        return jsonResponse(200, {
          id: 'draft-update',
          message: metadataMessage({
            id: 'old-message',
            threadId: 'thread-update',
            from: 'Alex Morgan <outreach@example.com>',
            subject: 'Re: Question',
            to: 'alice@example.com',
          }),
        });
      }
      return jsonResponse(200, { id: 'draft-update', message: { id: 'new-message' } });
    });

    await createAdapter(fetchImpl).updateDraft('draft-update', {
      textBody: 'New answer',
      htmlBody: '<p>New answer</p>',
      quoteOriginalMessageId: 'source-message',
    });

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/gmail/v1/users/me/drafts/draft-update',
      '/gmail/v1/users/me/messages/source-message',
      '/gmail/v1/users/me/drafts/draft-update',
    ]);
    const raw = decodedRaw(calls[2]?.init ?? {});
    const mime = decodedMime(raw);
    expect(raw).toContain('From: Alex Morgan <outreach@example.com>\r\n');
    expect(mime).toContain(
      'New answer\r\n\r\nOn Mon, Nov 2, 2026 at 10:15 AM Alice <alice@example.com> wrote:\r\n> Original question',
    );
    expect(mime).toContain('<p>New answer</p><br><div class="gmail_quote">');
    expect(mime).toContain('<p>Original question</p></blockquote>');
  });

  it('rewrites From with the display name and re-encodes a decoded non-ASCII sender', async () => {
    const { fetchImpl, calls } = createFakeFetch((_url, init) => {
      if (init.method === 'GET') {
        return jsonResponse(200, {
          id: 'draft-update',
          message: metadataMessage({ id: 'old-message', from: 'Nicolò <nicolo@example.com>' }),
        });
      }
      return jsonResponse(200, { id: 'draft-update', message: { id: 'new-message' } });
    });
    const adapter = createAdapter(fetchImpl);

    await adapter.updateDraft('draft-update', { textBody: 'Same sender' });
    await adapter.updateDraft('draft-update', {
      from: 'alias@example.com',
      fromDisplayName: 'Example Team',
      textBody: 'New sender',
    });

    const encoded = Buffer.from('Nicolò', 'utf8').toString('base64');
    expect(decodedRaw(calls[1]?.init ?? {})).toContain(
      `From: =?UTF-8?B?${encoded}?= <nicolo@example.com>\r\n`,
    );
    expect(decodedRaw(calls[3]?.init ?? {})).toContain(
      'From: "Example Team" <alias@example.com>\r\n',
    );
  });

  it('preserves the complete MIME body and attachments for header-only updates', async () => {
    const original = [
      'From: old@example.com',
      'To: alice@example.com',
      'Subject: Old subject',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mixed"',
      '',
      '--mixed',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Original body',
      '--mixed',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="deck.pdf"',
      '',
      'JVBERi0=',
      '--mixed--',
      '',
    ].join('\r\n');
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts/draft-header-only');
      if (init.method === 'GET') {
        expect(url.search).toBe('?format=raw');
        return jsonResponse(200, {
          id: 'draft-header-only',
          message: {
            id: 'old-message',
            threadId: 'thread-1',
            raw: Buffer.from(original, 'utf8').toString('base64url'),
          },
        });
      }
      return jsonResponse(200, {
        id: 'draft-header-only',
        message: { id: 'new-message', threadId: 'thread-1' },
      });
    });

    await createAdapter(fetchImpl).updateDraft('draft-header-only', {
      from: 'alias@example.com',
      fromDisplayName: 'Example Outreach',
      subject: 'Updated subject',
    });

    const updated = decodedRaw(calls[1]?.init ?? {});
    expect(updated).toContain('From: "Example Outreach" <alias@example.com>\r\n');
    expect(updated).toContain('Subject: Updated subject\r\n');
    expect(updated).toContain('Original body');
    expect(updated).toContain('Content-Disposition: attachment; filename="deck.pdf"');
    expect(updated).not.toContain('From: old@example.com');
  });

  it('maps a missing draft deletion to DRAFT_NOT_FOUND', async () => {
    const { fetchImpl } = createFakeFetch((url, init) => {
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts/missing-draft');
      expect(init.method).toBe('DELETE');
      return jsonResponse(404, { error: { message: 'not found' } });
    });

    const error = await expectGatewayError(
      createAdapter(fetchImpl).deleteDraft('missing-draft'),
      'DRAFT_NOT_FOUND',
    );
    expect(error.retryable).toBe(false);
  });

  it('maps Gmail draft metadata to a provider snapshot', async () => {
    const { fetchImpl } = createFakeFetch((url, init) => {
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts/draft-get');
      expect(url.search).toBe('?format=metadata');
      expect(init.method).toBe('GET');
      return jsonResponse(200, {
        id: 'draft-get',
        message: metadataMessage({
          id: 'message-get',
          threadId: 'thread-get',
          subject: 'Snapshot subject',
          to: 'Alice <alice@example.com>, bob@example.com',
          messageId: '<draft-message@example.com>',
        }),
      });
    });

    await expect(createAdapter(fetchImpl).getDraft('draft-get')).resolves.toEqual({
      providerDraftId: 'draft-get',
      providerMessageId: 'message-get',
      threadId: 'thread-get',
      internetMessageId: '<draft-message@example.com>',
      providerWebUrl: 'https://mail.google.com/mail/u/0/#drafts/message-get',
      subject: 'Snapshot subject',
      from: 'alice@example.com',
      to: ['alice@example.com', 'bob@example.com'],
    });
  });

  it('resolves a search result message id to Gmail stable draft id across pages', async () => {
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (url.pathname === '/gmail/v1/users/me/drafts' && !url.searchParams.has('pageToken')) {
        expect(url.searchParams.get('maxResults')).toBe('500');
        return jsonResponse(200, {
          drafts: [{ id: 'other-draft', message: { id: 'other-message' } }],
          nextPageToken: 'next-page',
        });
      }
      if (url.pathname === '/gmail/v1/users/me/drafts') {
        expect(url.searchParams.get('pageToken')).toBe('next-page');
        return jsonResponse(200, {
          drafts: [{ id: 'stable-draft', message: { id: 'searched-message' } }],
        });
      }
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts/stable-draft');
      expect(url.searchParams.get('format')).toBe('metadata');
      return jsonResponse(200, {
        id: 'stable-draft',
        message: metadataMessage({
          id: 'searched-message',
          subject: 'Legacy draft',
          to: 'prospect@example.com',
        }),
      });
    });

    await expect(
      createAdapter(fetchImpl).getDraftByMessageId('searched-message'),
    ).resolves.toMatchObject({
      providerDraftId: 'stable-draft',
      providerMessageId: 'searched-message',
      subject: 'Legacy draft',
    });
    expect(calls).toHaveLength(3);
  });
});
