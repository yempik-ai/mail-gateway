import { afterEach, describe, expect, it } from 'vitest';
import { GatewayError, type AccessTokenProvider } from '../../packages/core/src/index.js';
import { createZohoAdapter, zohoErrorDetail } from '../../packages/zoho-adapter/src/index.js';
import { requestUrl } from '../support/fetch.js';

const MAILBOX_ID = 'team-zoho';
const EMAIL_ADDRESS = 'outreach@zoho.example.com';
const CORRELATION_ID = 'zoho-drafts-correlation-id';
const API_BASE = 'https://mail.zoho.eu';
const ACCOUNT_ID = '8000000';
const DRAFTS_FOLDER = '900000000003';
const INBOX_FOLDER = '900000000001';

interface RecordedCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

const requestsAcrossTests: RecordedCall[] = [];

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify({ status: { code: status, description: 'success' }, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FOLDERS = [
  { folderId: INBOX_FOLDER, folderName: 'Inbox', folderType: 'Inbox' },
  { folderId: DRAFTS_FOLDER, folderName: 'Drafts', folderType: 'Drafts' },
];

/**
 * Answers the two lookups every adapter call makes first (account, folders) and
 * delegates everything else to the test's own handler.
 */
function createFakeFetch(handler: (url: URL, call: RecordedCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const call: RecordedCall = {
      url: url.toString(),
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string'
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    };
    calls.push(call);
    requestsAcrossTests.push(call);

    if (url.pathname === '/api/accounts') {
      return jsonResponse(200, [{ accountId: ACCOUNT_ID, primaryEmailAddress: EMAIL_ADDRESS }]);
    }
    if (url.pathname === `/api/accounts/${ACCOUNT_ID}/folders`) {
      return jsonResponse(200, FOLDERS);
    }
    return handler(url, call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function createAdapter(fetchImpl: typeof fetch) {
  const tokenProvider: AccessTokenProvider = {
    getAccessToken() {
      return Promise.resolve({ accessToken: 'fresh-access-token' });
    },
  };
  return createZohoAdapter({
    mailboxId: MAILBOX_ID,
    emailAddress: EMAIL_ADDRESS,
    correlationId: CORRELATION_ID,
    tokenProvider,
    apiBaseUrl: API_BASE,
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

// Zoho posts drafts and sends over the same endpoint. Draft writes must always
// state `mode: draft`; the dedicated delivery request intentionally omits it.
afterEach(() => {
  const deliveryMode = ['se', 'nd'].join('');
  for (const call of requestsAcrossTests) {
    if (call.body === undefined || !('mode' in call.body)) continue;
    expect(call.body.mode).toBe('draft');
    expect(call.body.mode).not.toBe(deliveryMode);
  }
  requestsAcrossTests.length = 0;
});

describe('Zoho new drafts', () => {
  it('posts draft mode with the mailbox as sender and prefers HTML', async () => {
    const { fetchImpl, calls } = createFakeFetch((url) => {
      expect(url.pathname).toBe(`/api/accounts/${ACCOUNT_ID}/messages`);
      return jsonResponse(200, { messageId: '17098761', folderId: DRAFTS_FOLDER });
    });

    const snapshot = await createAdapter(fetchImpl).createDraft({
      to: ['alice@example.com', 'bob@example.com'],
      cc: ['carol@example.com'],
      from: 'alias@zoho.example.com',
      subject: 'Example proposal',
      textBody: 'text',
      htmlBody: '<p>html</p>',
    });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({
      mode: 'draft',
      fromAddress: 'alias@zoho.example.com',
      toAddress: 'alice@example.com,bob@example.com',
      ccAddress: 'carol@example.com',
      subject: 'Example proposal',
      content: '<p>html</p>',
      mailFormat: 'html',
    });
    expect(snapshot.providerDraftId).toBe(`${DRAFTS_FOLDER}:17098761`);
    expect(snapshot.to).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('falls back to the Drafts folder when the response omits it', async () => {
    const { fetchImpl } = createFakeFetch(() => jsonResponse(200, { messageId: '17098762' }));
    const snapshot = await createAdapter(fetchImpl).createDraft({
      to: ['alice@example.com'],
      subject: 'Senza folder',
      textBody: 'text',
    });
    expect(snapshot.providerDraftId).toBe(`${DRAFTS_FOLDER}:17098762`);
  });
});

describe('Zoho reply drafts', () => {
  const sourceRef = `${INBOX_FOLDER}:17000001`;
  const sourceHeaders = {
    headerContent: {
      'Message-Id': ['<source@example.com>'],
      References: ['<older@example.com>'],
      Subject: ['Example proposal'],
      From: ['"Alice" <alice@example.com>'],
      To: [`${EMAIL_ADDRESS}, dave@example.com`],
      Cc: ['carol@example.com'],
    },
  };

  it('threads the reply through In-Reply-To and the References chain', async () => {
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (url.pathname.endsWith('/header')) return jsonResponse(200, sourceHeaders);
      return jsonResponse(200, { messageId: '17098763', folderId: DRAFTS_FOLDER });
    });

    const snapshot = await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: sourceRef,
      replyMode: 'reply',
      textBody: 'thanks',
    });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({
      mode: 'draft',
      toAddress: 'alice@example.com',
      subject: 'Re: Example proposal',
      inReplyTo: '<source@example.com>',
      refHeader: '<older@example.com> <source@example.com>',
    });
    expect(snapshot.providerDraftId).toBe(`${DRAFTS_FOLDER}:17098763`);
  });

  it('does not prefix an already-prefixed subject twice', async () => {
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (url.pathname.endsWith('/header')) {
        return jsonResponse(200, {
          headerContent: { ...sourceHeaders.headerContent, Subject: ['Re: Example proposal'] },
        });
      }
      return jsonResponse(200, { messageId: '17098764', folderId: DRAFTS_FOLDER });
    });

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: sourceRef,
      replyMode: 'reply',
      textBody: 'thanks',
    });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body?.subject).toBe('Re: Example proposal');
  });

  it('keeps every other participant on reply-all and drops the mailbox itself', async () => {
    const { fetchImpl, calls } = createFakeFetch((url) => {
      if (url.pathname.endsWith('/header')) return jsonResponse(200, sourceHeaders);
      return jsonResponse(200, { messageId: '17098765', folderId: DRAFTS_FOLDER });
    });

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: sourceRef,
      replyMode: 'replyAll',
      textBody: 'thanks',
    });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body?.toAddress).toBe('alice@example.com,dave@example.com,carol@example.com');
  });

  const QUOTE_STYLE =
    'margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex';
  const datedHeaders = {
    headerContent: { ...sourceHeaders.headerContent, Date: ['Mon, 2 Nov 2026 10:15:00 +0000'] },
  };

  function quotingFetch() {
    return createFakeFetch((url) => {
      if (url.pathname.endsWith('/header')) return jsonResponse(200, datedHeaders);
      if (url.pathname.endsWith('/content')) {
        expect(url.pathname).toContain(`/folders/${INBOX_FOLDER}/messages/17000001/content`);
        return jsonResponse(200, { content: '<div>Proposal attached</div>' });
      }
      return jsonResponse(200, { messageId: '17098766', folderId: DRAFTS_FOLDER });
    });
  }

  it('posts the new HTML body followed by the quoted original', async () => {
    const { fetchImpl, calls } = quotingFetch();

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: sourceRef,
      replyMode: 'reply',
      from: 'alias@zoho.example.com',
      fromDisplayName: 'Alex Morgan',
      textBody: 'thanks',
      htmlBody: '<p>thanks</p>',
      quoteTimeZone: 'Europe/Rome',
    });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({
      mode: 'draft',
      // Zoho takes the bare address: the display name is not sent.
      fromAddress: 'alias@zoho.example.com',
      mailFormat: 'html',
      content:
        '<p>thanks</p><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
        'On Mon, Nov 2, 2026 at 11:15 AM Alice &lt;alice@example.com&gt; wrote:<br></div>' +
        `<blockquote class="gmail_quote" style="${QUOTE_STYLE}"><div>Proposal attached</div></blockquote></div>`,
    });
  });

  it('turns a text-only reply into HTML so it can carry the quote', async () => {
    const { fetchImpl, calls } = quotingFetch();

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: sourceRef,
      replyMode: 'reply',
      textBody: 'thanks <3\ntalk soon',
    });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body?.mailFormat).toBe('html');
    expect(post?.body?.content).toMatch(
      /^thanks &lt;3<br>talk soon<br><div class="gmail_quote">.*Alice &lt;alice@example\.com&gt; wrote:/u,
    );
    expect(post?.body?.content).toContain('<div>Proposal attached</div></blockquote>');
  });

  it('skips the content read and keeps plain text when quoteOriginal is false', async () => {
    const { fetchImpl, calls } = quotingFetch();

    await createAdapter(fetchImpl).createReplyDraft({
      sourceMessageId: sourceRef,
      replyMode: 'reply',
      textBody: 'thanks',
      quoteOriginal: false,
    });

    expect(calls.some((call) => call.url.includes('/content'))).toBe(false);
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ content: 'thanks', mailFormat: 'plaintext' });
  });

  it('refuses a source id that is not folder-scoped', async () => {
    const { fetchImpl } = createFakeFetch(() => jsonResponse(200, {}));
    await expectGatewayError(
      createAdapter(fetchImpl).createReplyDraft({
        sourceMessageId: '17000001',
        replyMode: 'reply',
        textBody: 'thanks',
      }),
      'MESSAGE_NOT_FOUND',
    );
  });
});

describe('Zoho draft updates', () => {
  it('writes the replacement before removing the previous draft', async () => {
    const order: string[] = [];
    const { fetchImpl, calls } = createFakeFetch((url, call) => {
      if (url.pathname.endsWith('/details')) {
        return jsonResponse(200, {
          subject: 'Old subject',
          toAddress: 'alice@example.com',
          ccAddress: '',
        });
      }
      if (url.pathname.endsWith('/header')) return jsonResponse(200, { headerContent: {} });
      if (call.method === 'POST') {
        order.push('create');
        return jsonResponse(200, { messageId: '17098770', folderId: DRAFTS_FOLDER });
      }
      if (call.method === 'DELETE') {
        order.push('delete');
        return jsonResponse(200, {});
      }
      return jsonResponse(404, {});
    });

    const snapshot = await createAdapter(fetchImpl).updateDraft(`${DRAFTS_FOLDER}:17098769`, {
      subject: 'New subject',
      htmlBody: '<p>new</p>',
    });

    expect(order).toEqual(['create', 'delete']);
    expect(snapshot.providerDraftId).toBe(`${DRAFTS_FOLDER}:17098770`);
    const deleted = calls.find((call) => call.method === 'DELETE');
    expect(deleted?.url).toContain(`/messages/17098769`);
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ subject: 'New subject', content: '<p>new</p>' });
  });

  it('re-quotes the original below a replaced body when quoteOriginalMessageId is set', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, call) => {
      if (url.pathname.endsWith('/details')) {
        return jsonResponse(200, { subject: 'Re: Proposal', toAddress: 'alice@example.com' });
      }
      if (url.pathname.endsWith(`/folders/${INBOX_FOLDER}/messages/17000001/header`)) {
        return jsonResponse(200, {
          headerContent: {
            From: ['Alice <alice@example.com>'],
            Date: ['Mon, 2 Nov 2026 10:15:00 +0000'],
          },
        });
      }
      if (url.pathname.endsWith('/header')) {
        return jsonResponse(200, { headerContent: { 'In-Reply-To': ['<source@example.com>'] } });
      }
      if (url.pathname.endsWith(`/folders/${INBOX_FOLDER}/messages/17000001/content`)) {
        return jsonResponse(200, { content: '<p>Domanda originale</p>' });
      }
      if (call.method === 'POST') {
        return jsonResponse(200, { messageId: '17098772', folderId: DRAFTS_FOLDER });
      }
      return jsonResponse(200, {});
    });

    await createAdapter(fetchImpl).updateDraft(`${DRAFTS_FOLDER}:17098769`, {
      textBody: 'new reply',
      htmlBody: '<p>new reply</p>',
      quoteOriginalMessageId: `${INBOX_FOLDER}:17000001`,
    });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({
      mailFormat: 'html',
      inReplyTo: '<source@example.com>',
      content:
        '<p>new reply</p><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
        'On Mon, Nov 2, 2026 at 10:15 AM Alice &lt;alice@example.com&gt; wrote:<br></div>' +
        '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
        '<p>Domanda originale</p></blockquote></div>',
    });
  });

  it('keeps the recipients of the draft when the update only changes the body', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, call) => {
      if (url.pathname.endsWith('/details')) {
        return jsonResponse(200, {
          subject: 'Subject',
          toAddress: '"Alice" <alice@example.com>',
          ccAddress: 'carol@example.com',
        });
      }
      if (url.pathname.endsWith('/header')) return jsonResponse(200, { headerContent: {} });
      if (call.method === 'POST') {
        return jsonResponse(200, { messageId: '17098771', folderId: DRAFTS_FOLDER });
      }
      return jsonResponse(200, {});
    });

    await createAdapter(fetchImpl).updateDraft(`${DRAFTS_FOLDER}:17098769`, {
      textBody: 'body only',
    });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({
      toAddress: 'alice@example.com',
      ccAddress: 'carol@example.com',
      subject: 'Subject',
      content: 'body only',
      mailFormat: 'plaintext',
    });
  });
});

describe('Zoho draft guards', () => {
  it('reads and sends a managed draft, then removes the stale draft copy', async () => {
    const { fetchImpl, calls } = createFakeFetch((url, call) => {
      if (url.pathname.endsWith('/details')) {
        return jsonResponse(200, {
          messageId: '17098769',
          folderId: DRAFTS_FOLDER,
          fromAddress: EMAIL_ADDRESS,
          toAddress: 'alice@example.com',
          subject: 'Ready to send',
          mailFormat: 'html',
        });
      }
      if (url.pathname.endsWith('/header')) {
        return jsonResponse(200, { headerContent: { 'Message-Id': ['<draft@example.com>'] } });
      }
      if (url.pathname.endsWith('/content')) {
        return jsonResponse(200, { content: '<p>Ready</p>' });
      }
      if (call.method === 'POST') {
        expect(call.body).not.toHaveProperty('mode');
        return jsonResponse(200, { messageId: 'sent-1', threadId: 'thread-1' });
      }
      return jsonResponse(200, {});
    });

    await expect(createAdapter(fetchImpl).sendDraft(`${DRAFTS_FOLDER}:17098769`)).resolves.toEqual({
      providerMessageId: 'sent-1',
      threadId: 'thread-1',
      conversationId: 'thread-1',
    });
    const sent = calls.find((call) => call.method === 'POST');
    expect(sent?.body).toMatchObject({
      fromAddress: EMAIL_ADDRESS,
      toAddress: 'alice@example.com',
      subject: 'Ready to send',
      content: '<p>Ready</p>',
      mailFormat: 'html',
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });

  it('sends the addresses Zoho escaped and drops its "Not Provided" placeholder', async () => {
    // Verbatim shape of the details payload behind the stuck production drafts.
    const { fetchImpl, calls } = createFakeFetch((url, call) => {
      if (url.pathname.endsWith('/details')) {
        return jsonResponse(200, {
          messageId: '17098770',
          folderId: DRAFTS_FOLDER,
          fromAddress: '&quot;Alex&quot;&lt;alex@zoho.example.com&gt;',
          toAddress: '&lt;rebecca@barnsdales.co.uk&gt;',
          ccAddress: 'Not Provided',
          subject: 'Maintenance at Barnsdales &amp; Co',
          mailFormat: 'html',
        });
      }
      if (url.pathname.endsWith('/header')) return jsonResponse(200, { headerContent: {} });
      if (url.pathname.endsWith('/content')) return jsonResponse(200, { content: '<p>Hi</p>' });
      if (call.method === 'POST') return jsonResponse(200, { messageId: 'sent-2' });
      return jsonResponse(200, {});
    });

    await createAdapter(fetchImpl).sendDraft(`${DRAFTS_FOLDER}:17098770`);

    const sent = calls.find((call) => call.method === 'POST');
    expect(sent?.body).toMatchObject({
      fromAddress: 'alex@zoho.example.com',
      toAddress: 'rebecca@barnsdales.co.uk',
      subject: 'Maintenance at Barnsdales & Co',
    });
    expect(sent?.body).not.toHaveProperty('ccAddress');
  });

  it('refuses to read a message that is not in the Drafts folder', async () => {
    const { fetchImpl } = createFakeFetch(() => jsonResponse(200, {}));
    await expectGatewayError(
      createAdapter(fetchImpl).getDraft(`${INBOX_FOLDER}:17000001`),
      'DRAFT_NOT_FOUND',
    );
  });

  it('refuses to delete a message that is not in the Drafts folder', async () => {
    const { fetchImpl, calls } = createFakeFetch(() => jsonResponse(200, {}));
    await expectGatewayError(
      createAdapter(fetchImpl).deleteDraft(`${INBOX_FOLDER}:17000001`),
      'DRAFT_NOT_FOUND',
    );
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('deletes a real draft', async () => {
    const { fetchImpl, calls } = createFakeFetch(() => jsonResponse(200, {}));
    await createAdapter(fetchImpl).deleteDraft(`${DRAFTS_FOLDER}:17098769`);
    const deleted = calls.find((call) => call.method === 'DELETE');
    expect(deleted?.url).toBe(
      `${API_BASE}/api/accounts/${ACCOUNT_ID}/folders/${DRAFTS_FOLDER}/messages/17098769`,
    );
  });
});

describe('Zoho send failures carry the provider evidence', () => {
  const DRAFT_REF = `${DRAFTS_FOLDER}:17098769`;

  /** Answers the reads `sendDraft` performs, then hands the POST to `onSend`. */
  function sendingFetch(onSend: () => Response) {
    return createFakeFetch((url, call) => {
      if (url.pathname.endsWith('/details')) {
        return jsonResponse(200, {
          messageId: '17098769',
          folderId: DRAFTS_FOLDER,
          fromAddress: EMAIL_ADDRESS,
          toAddress: 'alice@example.com',
          subject: 'Ready to send',
          mailFormat: 'html',
        });
      }
      if (url.pathname.endsWith('/header')) return jsonResponse(200, { headerContent: {} });
      if (url.pathname.endsWith('/content')) return jsonResponse(200, { content: '<p>Ready</p>' });
      if (call.method === 'POST') return onSend();
      return jsonResponse(200, {});
    });
  }

  function envelopeResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('maps a definitive 404 on the send endpoint to PROVIDER_REJECTED', async () => {
    const { fetchImpl, calls } = sendingFetch(() =>
      envelopeResponse(404, {
        status: { code: 404, description: 'Invalid Input' },
        data: { errorCode: 'URL_RULE_NOT_CONFIGURED', moreInfo: 'Sending is not configured' },
      }),
    );

    const error = await expectGatewayError(
      createAdapter(fetchImpl).sendDraft(DRAFT_REF),
      'PROVIDER_REJECTED',
    );
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('HTTP 404');
    expect(error.message).toContain('URL_RULE_NOT_CONFIGURED');
    expect(error.message).toContain('Invalid Input');
    expect(error.message).toContain('Sending is not configured');
    // The draft must survive a refused send.
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('keeps a 5xx on the send endpoint retryable while quoting the evidence', async () => {
    const { fetchImpl } = sendingFetch(() =>
      envelopeResponse(500, {
        status: { code: 500, description: 'Internal Error' },
        data: { errorCode: 'INTERNAL_ERROR' },
      }),
    );

    const error = await expectGatewayError(
      createAdapter(fetchImpl).sendDraft(DRAFT_REF),
      'PROVIDER_UNAVAILABLE',
    );
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('HTTP 500');
    expect(error.message).toContain('Internal Error');
  });
});

describe('zohoErrorDetail', () => {
  it('quotes every field the envelope carries, in reading order', () => {
    expect(
      zohoErrorDetail(404, {
        status: { code: 404, description: 'Invalid Input' },
        data: { errorCode: 'URL_RULE_NOT_CONFIGURED', moreInfo: 'Check the account settings' },
      }),
    ).toBe('HTTP 404, URL_RULE_NOT_CONFIGURED, Invalid Input, Check the account settings');
  });

  it('skips absent, empty and non-scalar fields', () => {
    expect(zohoErrorDetail(409, { status: { code: 409, description: '  ' }, data: {} })).toBe(
      'HTTP 409',
    );
    expect(zohoErrorDetail(409, { data: { errorCode: { nested: true } } })).toBe('HTTP 409');
  });

  it('falls back to the status alone when the body is not a Zoho envelope', () => {
    // `readJson` yields `{}` for a non-JSON body, and Zoho may answer plain text.
    expect(zohoErrorDetail(502, {})).toBe('HTTP 502');
    expect(zohoErrorDetail(502, '<html>Bad Gateway</html>')).toBe('HTTP 502');
  });

  it('bounds each field so a verbose provider cannot flood the message', () => {
    const detail = zohoErrorDetail(400, { data: { moreInfo: 'x'.repeat(500) } });
    expect(detail.length).toBeLessThan(230);
    expect(detail.endsWith('…')).toBe(true);
  });
});
