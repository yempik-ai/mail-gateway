import { describe, expect, it } from 'vitest';
import {
  decodeZohoMessage,
  decodeZohoText,
  headerValue,
  normalizeZohoMessage,
} from '../../packages/zoho-adapter/src/index.js';

const MAILBOX_ID = 'team-zoho';

/** Shape returned by the Zoho list endpoint, where every scalar is a string. */
function listEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: '1709876190693100009',
    folderId: '900000000042',
    threadId: '1709876190693100000',
    subject: 'Re: Example proposal',
    summary: 'Hi, thanks for your message',
    fromAddress: '"Alice Rossi" <alice@example.com>',
    toAddress: 'outreach@zoho.example.com',
    ccAddress: '',
    receivedTime: '1709887053409',
    sentDateInGMT: '1709867251000',
    hasAttachment: '0',
    status: '1',
    ...overrides,
  };
}

describe('normalizeZohoMessage', () => {
  it('exposes the folder-scoped composite id the other endpoints need', () => {
    const email = normalizeZohoMessage(listEntry(), MAILBOX_ID);
    expect(email.messageId).toBe('900000000042:1709876190693100009');
    expect(email.folderIds).toEqual(['900000000042']);
    expect(email.provider).toBe('zoho');
    expect(email.mailboxId).toBe(MAILBOX_ID);
  });

  it('converts epoch milliseconds into ISO timestamps', () => {
    const email = normalizeZohoMessage(listEntry(), MAILBOX_ID);
    expect(email.receivedAt).toBe('2024-03-08T08:37:33.409Z');
    expect(email.sentAt).toBe('2024-03-08T03:07:31.000Z');
  });

  it('reads Zoho string flags as booleans', () => {
    expect(normalizeZohoMessage(listEntry(), MAILBOX_ID).isRead).toBe(true);
    expect(normalizeZohoMessage(listEntry({ status: '0' }), MAILBOX_ID).isRead).toBe(false);
    expect(normalizeZohoMessage(listEntry({ hasAttachment: '1' }), MAILBOX_ID).hasAttachments).toBe(
      true,
    );
  });

  it('parses display names out of the address fields', () => {
    const email = normalizeZohoMessage(
      listEntry({ ccAddress: '"Bob, Jr" <bob@example.com>, carol@example.com' }),
      MAILBOX_ID,
    );
    expect(email.from).toEqual({ name: 'Alice Rossi', address: 'alice@example.com' });
    expect(email.cc).toEqual([
      { name: 'Bob, Jr', address: 'bob@example.com' },
      { address: 'carol@example.com' },
    ]);
  });

  it('mirrors the thread id onto conversationId for the reply matcher', () => {
    const email = normalizeZohoMessage(listEntry(), MAILBOX_ID);
    expect(email.threadId).toBe('1709876190693100000');
    expect(email.conversationId).toBe('1709876190693100000');
  });

  it('leaves the RFC header fields empty: the list payload does not carry them', () => {
    const email = normalizeZohoMessage(listEntry(), MAILBOX_ID);
    expect(email.references).toEqual([]);
    expect(email.internetMessageId).toBeUndefined();
    expect(email.inReplyTo).toBeUndefined();
  });
});

describe('headerValue', () => {
  const headerContent = {
    'Message-Id': ['<18e5a828422.b64e1ac10@example.com>'],
    References: ['<one@example.com> <two@example.com>'],
    Received: ['first hop', 'second hop'],
    'X-Empty': [''],
  };

  it('matches header names case-insensitively', () => {
    expect(headerValue(headerContent, 'message-id')).toBe('<18e5a828422.b64e1ac10@example.com>');
    expect(headerValue(headerContent, 'REFERENCES')).toBe('<one@example.com> <two@example.com>');
  });

  it('takes the first meaningful value of a repeated header', () => {
    expect(headerValue(headerContent, 'received')).toBe('first hop');
    expect(headerValue(headerContent, 'x-empty')).toBeUndefined();
  });

  it('returns undefined for an absent header or a malformed payload', () => {
    expect(headerValue(headerContent, 'in-reply-to')).toBeUndefined();
    expect(headerValue(undefined, 'message-id')).toBeUndefined();
  });
});

describe('decodeZohoMessage', () => {
  it('unescapes the entities Zoho applies and drops its "Not Provided" placeholder', () => {
    const decoded = decodeZohoMessage({
      fromAddress: '&quot;Pippa&quot;&lt;pippa@carrickandreid.co.uk&gt;',
      toAddress: '&lt;alex@zoho.example.com&gt;',
      ccAddress: 'Not Provided',
      sender: '',
      subject: 'Fixflo &amp; friends',
      summary: 'Looks like you&#39;re managing 52 blocks',
      status: '1',
    });

    expect(decoded).toEqual({
      fromAddress: '"Pippa"<pippa@carrickandreid.co.uk>',
      toAddress: '<alex@zoho.example.com>',
      subject: 'Fixflo & friends',
      summary: "Looks like you're managing 52 blocks",
      status: '1',
    });
    expect(normalizeZohoMessage(decoded, MAILBOX_ID)).toMatchObject({
      from: { name: 'Pippa', address: 'pippa@carrickandreid.co.uk' },
      to: [{ address: 'alex@zoho.example.com' }],
      cc: [],
    });
  });

  it('leaves plain text and unknown entities untouched', () => {
    expect(decodeZohoText('a@b.c')).toBe('a@b.c');
    expect(decodeZohoText('&unknown; &#x41;&#66;')).toBe('&unknown; AB');
  });
});
