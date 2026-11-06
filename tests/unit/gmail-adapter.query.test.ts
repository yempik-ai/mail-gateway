import { describe, expect, it } from 'vitest';
import { translateGmailQuery } from '../../packages/gmail-adapter/src/index.js';

describe('translateGmailQuery', () => {
  it('returns an empty query when no filters are provided', () => {
    expect(translateGmailQuery({})).toBe('');
  });

  it('combines every supported filter in a stable order', () => {
    expect(
      translateGmailQuery({
        from: 'alice@example.com',
        to: 'team@example.com',
        subject: 'Quarterly "Review"',
        unreadOnly: true,
        hasAttachment: true,
        after: '2026-08-01T23:30:00.000Z',
        before: '2026-08-04T00:00:00.000Z',
        folder: 'sent',
        text: 'customer success',
        limit: 50,
        cursor: 'opaque-cursor',
      }),
    ).toBe(
      'from:alice@example.com to:team@example.com subject:"Quarterly \\"Review\\"" is:unread has:attachment after:2026/08/01 before:2026/08/04 in:sent customer success',
    );
  });

  it('converts ISO dates to Gmail date syntax', () => {
    expect(translateGmailQuery({ after: '2026-01-02', before: '2026-12-31T18:00:00.000Z' })).toBe(
      'after:2026/01/02 before:2026/12/31',
    );
  });

  it.each([
    ['inbox', 'in:inbox'],
    ['sent', 'in:sent'],
    ['drafts', 'in:drafts'],
    ['archive', '-in:inbox -in:sent -in:drafts -in:trash'],
    ['all', ''],
  ] as const)('maps the %s folder', (folder, expected) => {
    expect(translateGmailQuery({ folder })).toBe(expected);
  });

  it('never emits a sending operator', () => {
    const output = translateGmailQuery({
      from: 'alice@example.com',
      to: 'bob@example.com',
      subject: 'Hello',
      folder: 'all',
    });
    expect(output.toLowerCase()).not.toContain('send');
  });
});
