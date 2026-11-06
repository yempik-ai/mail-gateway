import { describe, expect, it } from 'vitest';
import { MAX_BODY_CHARS, shapeEmailBody } from '../../apps/mcp-server/src/mail-search.js';
import type { NormalizedEmail } from '../../packages/core/src/index.js';

function email(overrides: Partial<NormalizedEmail>): NormalizedEmail {
  return {
    mailboxId: 'second-gmail',
    provider: 'gmail',
    messageId: 'm1',
    replyTo: [],
    to: [],
    cc: [],
    subject: 'subject',
    isRead: true,
    isDraft: false,
    hasAttachments: false,
    folderIds: [],
    labelIds: [],
    references: [],
    ...overrides,
  };
}

describe('shapeEmailBody', () => {
  it('returns only the text body by default', () => {
    const shaped = shapeEmailBody(email({ textBody: 'plain', htmlBody: '<p>html</p>' }));
    expect(shaped.textBody).toBe('plain');
    expect(shaped.htmlBody).toBeUndefined();
  });

  it('falls back to HTML when text-only is requested but no text part exists', () => {
    const shaped = shapeEmailBody(email({ htmlBody: '<p>only html</p>' }), 'text');
    expect(shaped.textBody).toBeUndefined();
    expect(shaped.htmlBody).toBe('<p>only html</p>');
  });

  it('returns only HTML for "html" and both for "both"', () => {
    const source = email({ textBody: 'plain', htmlBody: '<p>html</p>' });
    const htmlOnly = shapeEmailBody(source, 'html');
    expect(htmlOnly.textBody).toBeUndefined();
    expect(htmlOnly.htmlBody).toBe('<p>html</p>');
    const both = shapeEmailBody(source, 'both');
    expect(both.textBody).toBe('plain');
    expect(both.htmlBody).toBe('<p>html</p>');
  });

  it('truncates oversized bodies with an explicit marker', () => {
    const long = 'x'.repeat(MAX_BODY_CHARS + 500);
    const shaped = shapeEmailBody(email({ textBody: long }));
    expect(shaped.textBody?.length).toBeLessThan(long.length);
    expect(shaped.textBody).toContain(`[truncated; full length ${long.length} chars]`);
  });

  it('leaves messages without bodies untouched', () => {
    const shaped = shapeEmailBody(email({}));
    expect(shaped.textBody).toBeUndefined();
    expect(shaped.htmlBody).toBeUndefined();
    expect(shaped.subject).toBe('subject');
  });
});
