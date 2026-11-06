import { afterEach, describe, expect, it } from 'vitest';
import { GatewayError, type AccessTokenProvider } from '../../packages/core/src/index.js';
import {
  createMicrosoftAdapter,
  REPLY_BODY_CONTAINER_CLASS,
  REPLY_BODY_CONTAINER_ID,
  REPLY_HISTORY_CLASS,
} from '../../packages/microsoft-adapter/src/index.js';
import { requestBody, requestUrl } from '../support/fetch.js';

const MAILBOX_ID = 'sales-outlook';
const EMAIL_ADDRESS = 'outreach@corp.example.com';
const CORRELATION_ID = 'microsoft-drafts-correlation-id';

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

const requestsAcrossTests: RecordedCall[] = [];

function jsonResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recipient(address: string, name?: string): Record<string, unknown> {
  return {
    emailAddress: {
      ...(name === undefined ? {} : { name }),
      address,
    },
  };
}

// Shape of the body Graph returns from createReply: a full HTML document whose
// body holds an empty compose area followed by the quoted conversation.
const GRAPH_QUOTED_REPLY =
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
  '<style type="text/css" style="display:none">P {margin-top:0;margin-bottom:0;}</style></head>' +
  '<body dir="ltr"><div id="appendonsend"></div><hr style="display:inline-block;width:98%">' +
  '<div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Alice &lt;alice@example.com&gt;<br><b>Sent:</b> Monday</div>' +
  '<div>Original question</div></body></html>';
const GRAPH_QUOTED_INNER =
  '<div id="appendonsend"></div><hr style="display:inline-block;width:98%">' +
  '<div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Alice &lt;alice@example.com&gt;<br><b>Sent:</b> Monday</div>' +
  '<div>Original question</div>';

const BODY_OPEN = `<div id="${REPLY_BODY_CONTAINER_ID}" class="${REPLY_BODY_CONTAINER_CLASS}">`;
const HISTORY_OPEN = `<div class="${REPLY_HISTORY_CLASS}">`;

// A reply draft as Graph stores it after creation, with nested divs inside both
// the gateway's body (signature block, a `>` in an attribute, a commented-out
// close tag) and Graph's quote, so only correct depth tracking finds the end
// of the body container.
const STORED_PREFIX =
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
  '<style type="text/css">div.x { content: "<div>"; }</style></head><body dir="ltr">';
const STORED_OLD_BODY =
  '<p>First version</p><div title="a > b"><div class="gmail_signature">' +
  '<div>Alex</div><!-- </div> --></div></div>';
const STORED_HISTORY =
  `${HISTORY_OPEN}<div id="appendonsend"></div><hr style="display:inline-block;width:98%">` +
  '<div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Alice<br><b>Sent:</b> Monday</div>' +
  '<div><div class="x_elementToProof">Original question</div>' +
  '<div id="x_yempik-reply-body" class="x_yempik_reply_body"><div>Our earlier reply</div></div>' +
  '<div><b>From:</b> Alex<br><b>Sent:</b> Sunday</div><div>Older history</div></div></div>';
const STORED_SUFFIX = '</body></html>';
const STORED_REPLY_DRAFT = `${STORED_PREFIX}${BODY_OPEN}${STORED_OLD_BODY}</div>${STORED_HISTORY}${STORED_SUFFIX}`;

function draftFixture(
  overrides: Partial<{
    id: string;
    subject: string;
    isDraft: boolean;
    conversationId: string;
    internetMessageId: string;
    webLink: string;
    toRecipients: Record<string, unknown>[];
    body: Record<string, unknown>;
  }> = {},
): Record<string, unknown> {
  return {
    id: 'draft-1',
    subject: 'Draft subject',
    isDraft: true,
    conversationId: 'conversation-1',
    internetMessageId: '<draft-1@example.com>',
    webLink: 'https://outlook.office.com/mail/deeplink/compose/draft-1',
    toRecipients: [recipient('alice@example.com', 'Alice')],
    ...overrides,
  };
}

function createFakeFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const call = init === undefined ? { url: url.toString() } : { url: url.toString(), init };
    calls.push(call);
    requestsAcrossTests.push(call);
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function createAdapter(fetchImpl: typeof fetch) {
  const tokenProvider: AccessTokenProvider = {
    getAccessToken() {
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

function bodyOf(call: RecordedCall): Record<string, unknown> {
  expect(typeof call.init?.body).toBe('string');
  return JSON.parse(requestBody(call.init)) as Record<string, unknown>;
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

afterEach(() => {
  const deliveryOperation = ['se', 'nd'].join('');
  const deliveryMessageOperation = [deliveryOperation, 'Mail'].join('');
  const prohibitedFinalSegments = [deliveryMessageOperation, 'reply', 'replyAll', 'forward'];

  for (const call of requestsAcrossTests) {
    const url = new URL(call.url);
    const finalSegment = url.pathname.split('/').at(-1);
    expect(prohibitedFinalSegments).not.toContain(finalSegment);
  }
  requestsAcrossTests.length = 0;
});

describe('Microsoft new drafts', () => {
  it('maps recipients and prefers HTML when both body representations are present', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      expect(url.pathname).toBe('/v1.0/me/messages');
      expect(url.search).toBe('');
      expect(init?.method).toBe('POST');
      return jsonResponse(
        201,
        draftFixture({
          id: 'created-draft',
          toRecipients: [recipient('alice@example.com'), recipient('bob@example.com')],
        }),
      );
    });

    const snapshot = await createAdapter(fetchImpl).createDraft({
      to: ['alice@example.com', 'bob@example.com'],
      cc: ['carol@example.com'],
      from: 'alex@corp.example.com',
      subject: 'New opportunity',
      textBody: 'Plain fallback',
      htmlBody: '<p>Rich draft</p>',
      replyTo: 'replies@example.com',
    });

    expect(bodyOf(calls[0]!)).toEqual({
      subject: 'New opportunity',
      body: { contentType: 'HTML', content: '<p>Rich draft</p>' },
      toRecipients: [recipient('alice@example.com'), recipient('bob@example.com')],
      from: recipient('alex@corp.example.com'),
      ccRecipients: [recipient('carol@example.com')],
      replyTo: [recipient('replies@example.com')],
    });
    expect(calls[0]?.init?.headers).toEqual({
      authorization: 'Bearer fresh-access-token',
      'content-type': 'application/json',
    });
    expect(snapshot).toEqual({
      providerDraftId: 'created-draft',
      providerMessageId: 'created-draft',
      threadId: 'conversation-1',
      conversationId: 'conversation-1',
      internetMessageId: '<draft-1@example.com>',
      providerWebUrl: 'https://outlook.office.com/mail/deeplink/compose/draft-1',
      subject: 'Draft subject',
      to: ['alice@example.com', 'bob@example.com'],
    });
  });

  it('uses a Text body and omits optional recipient fields when only text is provided', async () => {
    const { fetchImpl, calls } = createFakeFetch(() => jsonResponse(201, draftFixture()));

    await createAdapter(fetchImpl).createDraft({
      to: ['alice@example.com'],
      subject: 'Plain draft',
      textBody: 'Plain content',
    });

    expect(bodyOf(calls[0]!)).toEqual({
      subject: 'Plain draft',
      body: { contentType: 'Text', content: 'Plain content' },
      toRecipients: [recipient('alice@example.com')],
    });
  });

  it('sends the display name with the sender address', async () => {
    const { fetchImpl, calls } = createFakeFetch(() => jsonResponse(201, draftFixture()));

    await createAdapter(fetchImpl).createDraft({
      to: ['alice@example.com'],
      from: 'alex@corp.example.com',
      fromDisplayName: 'Alex Morgan',
      subject: 'Named sender',
      textBody: 'Hi',
    });

    expect(bodyOf(calls[0]!).from).toEqual(recipient('alex@corp.example.com', 'Alex Morgan'));
  });
});

describe('Microsoft reply drafts', () => {
  it('creates a reply-all draft and puts the new body above the quote Graph composed', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      if (calls.length === 1) {
        expect(url.pathname).toBe('/v1.0/me/messages/source%2Fmessage/createReplyAll');
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeUndefined();
        return jsonResponse(
          201,
          draftFixture({
            id: 'reply-draft',
            body: { contentType: 'html', content: GRAPH_QUOTED_REPLY },
          }),
        );
      }

      expect(url.pathname).toBe('/v1.0/me/messages/reply-draft');
      expect(url.search).toBe('');
      expect(init?.method).toBe('PATCH');
      return jsonResponse(200, { id: 'reply-draft', subject: 'Updated reply subject' });
    });

    const snapshot = await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: 'source/message',
      replyMode: 'replyAll',
      from: 'alex@corp.example.com',
      fromDisplayName: 'Alex Morgan',
      textBody: 'Plain fallback',
      htmlBody: '<p>Thanks for the update</p>',
    });

    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1]!)).toEqual({
      body: {
        contentType: 'HTML',
        content:
          `${BODY_OPEN}<p>Thanks for the update</p></div>` +
          `${HISTORY_OPEN}${GRAPH_QUOTED_INNER}</div>`,
      },
      from: recipient('alex@corp.example.com', 'Alex Morgan'),
    });
    // Graph's own header block is the attribution; no Gmail-style line is added.
    expect(JSON.stringify(bodyOf(calls[1]!))).not.toContain('wrote:');
    expect(snapshot).toMatchObject({
      providerDraftId: 'reply-draft',
      providerMessageId: 'reply-draft',
      subject: 'Updated reply subject',
      threadId: 'conversation-1',
    });
  });

  it('reads the draft body when Graph returns none and renders a text-only body as HTML', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      if (calls.length === 1) return jsonResponse(201, draftFixture({ id: 'reply-draft' }));
      if (calls.length === 2) {
        expect(init?.method).toBe('GET');
        expect(url.pathname).toBe('/v1.0/me/messages/reply-draft');
        expect(url.searchParams.get('$select')).toBe('body');
        return jsonResponse(200, {
          id: 'reply-draft',
          body: { contentType: 'html', content: GRAPH_QUOTED_REPLY },
        });
      }
      expect(init?.method).toBe('PATCH');
      return jsonResponse(200, { id: 'reply-draft' });
    });

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: 'source-message',
      replyMode: 'reply',
      textBody: 'Thanks <team>\nsee you',
    });

    expect(calls).toHaveLength(3);
    expect(bodyOf(calls[2]!)).toEqual({
      body: {
        contentType: 'HTML',
        content: `${BODY_OPEN}Thanks &lt;team&gt;<br>see you</div>${HISTORY_OPEN}${GRAPH_QUOTED_INNER}</div>`,
      },
    });
  });

  it('wraps the body without a history block when Graph composed no quote', async () => {
    const { fetchImpl, calls } = createFakeFetch(() =>
      calls.length === 1
        ? jsonResponse(
            201,
            draftFixture({
              id: 'reply-draft',
              body: { contentType: 'html', content: '<html><body>  </body></html>' },
            }),
          )
        : jsonResponse(200, { id: 'reply-draft' }),
    );

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: 'source-message',
      replyMode: 'reply',
      htmlBody: '<p>Only the answer</p>',
    });

    expect(bodyOf(calls[1]!)).toEqual({
      body: { contentType: 'HTML', content: `${BODY_OPEN}<p>Only the answer</p></div>` },
    });
  });

  it('replaces the Graph quote when quoteOriginal is false', async () => {
    const { fetchImpl, calls } = createFakeFetch((_url, init) => {
      if (calls.length === 1) {
        return jsonResponse(
          201,
          draftFixture({
            id: 'reply-draft',
            body: { contentType: 'html', content: GRAPH_QUOTED_REPLY },
          }),
        );
      }
      expect(init?.method).toBe('PATCH');
      return jsonResponse(200, { id: 'reply-draft' });
    });

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: 'source-message',
      replyMode: 'reply',
      textBody: 'No history',
      quoteOriginal: false,
    });

    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1]!)).toEqual({
      body: { contentType: 'Text', content: 'No history' },
    });
  });

  it('keeps the provider-generated quoted body when no content is provided', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      expect(url.pathname).toBe('/v1.0/me/messages/source-message/createReply');
      expect(init?.method).toBe('POST');
      return jsonResponse(201, draftFixture({ id: 'quoted-reply-draft' }));
    });

    const snapshot = await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: 'source-message',
      replyMode: 'reply',
    });

    expect(calls).toHaveLength(1);
    expect(snapshot.providerDraftId).toBe('quoted-reply-draft');
  });
});

describe('Microsoft draft mutation guards', () => {
  it('sends only after confirming the provider item is still a draft', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      if (calls.length === 1) {
        expect(init?.method).toBe('GET');
        return jsonResponse(200, draftFixture({ id: 'draft-to-send' }));
      }
      expect(url.pathname).toBe('/v1.0/me/messages/draft-to-send/send');
      expect(init?.method).toBe('POST');
      return jsonResponse(202, undefined);
    });

    await expect(createAdapter(fetchImpl).sendDraft('draft-to-send')).resolves.toEqual({
      threadId: 'conversation-1',
      conversationId: 'conversation-1',
      internetMessageId: '<draft-1@example.com>',
    });
    expect(calls.map((call) => call.init?.method)).toEqual(['GET', 'POST']);
  });

  it('never sends a non-draft provider item', async () => {
    const { fetchImpl, calls } = createFakeFetch(() =>
      jsonResponse(200, draftFixture({ id: 'received-message', isDraft: false })),
    );
    await expectGatewayError(
      createAdapter(fetchImpl).sendDraft('received-message'),
      'DRAFT_NOT_FOUND',
    );
    expect(calls).toHaveLength(1);
  });

  it('refuses to update a received message and never issues a PATCH', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      expect(url.pathname).toBe('/v1.0/me/messages/received-message');
      expect(url.searchParams.get('$select')).toBe(
        'id,subject,isDraft,conversationId,internetMessageId,webLink,from,toRecipients',
      );
      expect(init?.method).toBe('GET');
      return jsonResponse(200, draftFixture({ id: 'received-message', isDraft: false }));
    });

    const error = await expectGatewayError(
      createAdapter(fetchImpl).updateDraft('received-message', { subject: 'Must not change' }),
      'DRAFT_NOT_FOUND',
    );

    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(false);
  });

  it('updates only subject, body, and recipients after confirming the target is a draft', async () => {
    const { fetchImpl, calls } = createFakeFetch((_url, init) => {
      if (calls.length === 1) return jsonResponse(200, draftFixture({ id: 'draft-to-update' }));
      expect(init?.method).toBe('PATCH');
      return jsonResponse(200, {
        id: 'draft-to-update',
        subject: 'Updated subject',
        toRecipients: [recipient('new@example.com')],
      });
    });

    const snapshot = await createAdapter(fetchImpl).updateDraft('draft-to-update', {
      to: ['new@example.com'],
      subject: 'Updated subject',
      htmlBody: '<p>Updated body</p>',
    });

    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).search).toBe('');
    expect(bodyOf(calls[1]!)).toEqual({
      subject: 'Updated subject',
      toRecipients: [recipient('new@example.com')],
      body: { contentType: 'HTML', content: '<p>Updated body</p>' },
    });
    expect(snapshot.to).toEqual(['new@example.com']);
    expect(snapshot.subject).toBe('Updated subject');
  });

  it('replaces only the reply-body container and keeps the Graph quote byte for byte', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      if (calls.length === 1) {
        expect(init?.method).toBe('GET');
        expect(url.searchParams.get('$select')).toBe(
          'id,subject,isDraft,conversationId,internetMessageId,webLink,from,toRecipients,body',
        );
        return jsonResponse(
          200,
          draftFixture({
            id: 'draft-to-update',
            body: { contentType: 'html', content: STORED_REPLY_DRAFT },
          }),
        );
      }
      expect(init?.method).toBe('PATCH');
      return jsonResponse(200, { id: 'draft-to-update' });
    });

    const snapshot = await createAdapter(fetchImpl).updateDraft('draft-to-update', {
      textBody: 'New answer',
      htmlBody: '<div><p>New answer</p><div class="gmail_signature"><div>R</div></div></div>',
      quoteOriginalMessageId: 'source-message',
      quoteTimeZone: 'Europe/Rome',
    });

    // No source fetch: the quote already in the draft is kept.
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1]!)).toEqual({
      body: {
        contentType: 'HTML',
        content:
          `${STORED_PREFIX}${BODY_OPEN}` +
          '<div><p>New answer</p><div class="gmail_signature"><div>R</div></div></div>' +
          `</div>${STORED_HISTORY}${STORED_SUFFIX}`,
      },
    });
    expect(snapshot).not.toHaveProperty('quoteRebuilt');
  });

  it('renders a text-only body into a container with no history after it', async () => {
    const { fetchImpl, calls } = createFakeFetch(() =>
      calls.length === 1
        ? jsonResponse(
            200,
            draftFixture({
              id: 'draft-to-update',
              body: {
                contentType: 'html',
                content: `<html><body>${BODY_OPEN}<p>Old</p></div></body></html>`,
              },
            }),
          )
        : jsonResponse(200, { id: 'draft-to-update' }),
    );

    const snapshot = await createAdapter(fetchImpl).updateDraft('draft-to-update', {
      textBody: 'New <answer>\nbye',
      quoteOriginalMessageId: 'source-message',
    });

    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1]!)).toEqual({
      body: {
        contentType: 'HTML',
        content: `<html><body>${BODY_OPEN}New &lt;answer&gt;<br>bye</div></body></html>`,
      },
    });
    expect(snapshot).not.toHaveProperty('quoteRebuilt');
  });

  it('rebuilds the quote from the source and reports it when the draft has no container', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      if (calls.length === 1) {
        expect(url.searchParams.get('$select')).toContain('body');
        // Rewritten by hand in Outlook: the Graph quote is there, the marker is not.
        return jsonResponse(
          200,
          draftFixture({
            id: 'draft-to-update',
            body: { contentType: 'html', content: GRAPH_QUOTED_REPLY },
          }),
        );
      }
      if (calls.length === 2) {
        expect(init?.method).toBe('GET');
        expect(url.pathname).toBe('/v1.0/me/messages/source-message');
        expect(url.searchParams.get('$select')).toBe('body,from,sentDateTime,receivedDateTime');
        return jsonResponse(200, {
          id: 'source-message',
          from: recipient('alice@example.com', 'Alice Rossi'),
          sentDateTime: '2026-11-02T10:15:00Z',
          body: {
            contentType: 'html',
            content: '<html><body><p>Original question</p></body></html>',
          },
        });
      }
      expect(init?.method).toBe('PATCH');
      return jsonResponse(200, { id: 'draft-to-update' });
    });

    const snapshot = await createAdapter(fetchImpl).updateDraft('draft-to-update', {
      from: 'alex@corp.example.com',
      fromDisplayName: 'Alex Morgan',
      textBody: 'New answer',
      htmlBody: '<p>New answer</p>',
      quoteOriginalMessageId: 'source-message',
      quoteTimeZone: 'Europe/Rome',
    });

    expect(calls).toHaveLength(3);
    expect(bodyOf(calls[2]!)).toEqual({
      from: recipient('alex@corp.example.com', 'Alex Morgan'),
      body: {
        contentType: 'HTML',
        content:
          '<p>New answer</p><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
          'On Mon, Nov 2, 2026 at 11:15 AM Alice Rossi &lt;alice@example.com&gt; wrote:<br></div>' +
          '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
          '<p>Original question</p></blockquote></div>',
      },
    });
    expect(snapshot.quoteRebuilt).toBe(true);
  });

  it('rebuilds the quote when the draft body is stored as text', async () => {
    const { fetchImpl, calls } = createFakeFetch(() => {
      if (calls.length === 1) {
        return jsonResponse(
          200,
          draftFixture({
            id: 'draft-to-update',
            body: { contentType: 'text', content: `${BODY_OPEN}not markup</div>` },
          }),
        );
      }
      if (calls.length === 2) return jsonResponse(200, { id: 'source-message' });
      return jsonResponse(200, { id: 'draft-to-update' });
    });

    const snapshot = await createAdapter(fetchImpl).updateDraft('draft-to-update', {
      htmlBody: '<p>New answer</p>',
      quoteOriginalMessageId: 'source-message',
    });

    expect(calls.map((call) => call.init?.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(snapshot.quoteRebuilt).toBe(true);
  });

  it('does not report a rebuilt quote when the body is replaced on a non-reply draft', async () => {
    const { fetchImpl } = createFakeFetch((_url, init) =>
      init?.method === 'PATCH'
        ? jsonResponse(200, { id: 'draft-to-update' })
        : jsonResponse(200, draftFixture({ id: 'draft-to-update' })),
    );

    const snapshot = await createAdapter(fetchImpl).updateDraft('draft-to-update', {
      htmlBody: '<p>Outreach body</p>',
    });

    expect(snapshot).not.toHaveProperty('quoteRebuilt');
  });

  it('refuses to delete a received message and never issues a DELETE', async () => {
    const { fetchImpl, calls } = createFakeFetch(() =>
      jsonResponse(200, draftFixture({ id: 'received-message', isDraft: false })),
    );

    await expectGatewayError(
      createAdapter(fetchImpl).deleteDraft('received-message'),
      'DRAFT_NOT_FOUND',
    );

    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
  });

  it('deletes a confirmed draft with a GET followed by DELETE', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, init) => {
      if (calls.length === 1) {
        expect(init?.method).toBe('GET');
        expect(url.searchParams.get('$select')).toContain('isDraft');
        return jsonResponse(200, draftFixture({ id: 'draft-to-delete' }));
      }
      expect(url.pathname).toBe('/v1.0/me/messages/draft-to-delete');
      expect(url.search).toBe('');
      expect(init?.method).toBe('DELETE');
      return jsonResponse(204, undefined);
    });

    await createAdapter(fetchImpl).deleteDraft('draft-to-delete');

    expect(calls.map((call) => call.init?.method)).toEqual(['GET', 'DELETE']);
  });
});

describe('Microsoft draft not-found mapping', () => {
  it('maps a missing reply source to MESSAGE_NOT_FOUND', async () => {
    const { fetchImpl, calls } = createFakeFetch(() => jsonResponse(404, { error: 'not found' }));

    await expectGatewayError(
      createAdapter(fetchImpl).createReplyDraft({
        sourceMessageId: 'missing-source',
        replyMode: 'reply',
      }),
      'MESSAGE_NOT_FOUND',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('maps a missing draft snapshot to DRAFT_NOT_FOUND', async () => {
    const { fetchImpl, calls } = createFakeFetch(() => jsonResponse(404, { error: 'not found' }));

    await expectGatewayError(createAdapter(fetchImpl).getDraft('missing-draft'), 'DRAFT_NOT_FOUND');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('maps an unmapped definitive status to PROVIDER_REJECTED', async () => {
    const { fetchImpl } = createFakeFetch(() => jsonResponse(409, { error: 'conflict' }));

    const error = await expectGatewayError(
      createAdapter(fetchImpl).getDraft('conflicting-draft'),
      'PROVIDER_REJECTED',
    );
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('409');
  });
});
