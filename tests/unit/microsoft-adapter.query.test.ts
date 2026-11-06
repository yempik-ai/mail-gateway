import { describe, expect, it } from 'vitest';
import { folderPath, translateGraphQuery } from '../../packages/microsoft-adapter/src/index.js';

describe('translateGraphQuery', () => {
  it('uses filter mode with descending date order when text is absent', () => {
    expect(translateGraphQuery({})).toEqual({
      mode: 'filter',
      orderby: 'receivedDateTime desc',
    });
  });

  it('combines text and every structured term into one KQL search', () => {
    expect(
      translateGraphQuery({
        text: 'customer success',
        from: 'alice@example.com',
        to: 'team@example.com',
        subject: 'Quarterly "Review"',
        unreadOnly: true,
        hasAttachment: false,
        after: '2026-08-01T23:30:00.000Z',
        before: '2026-08-04T00:00:00.000Z',
        folder: 'sent',
        limit: 50,
        cursor: 'opaque-cursor',
      }),
    ).toEqual({
      mode: 'search',
      search:
        'customer success from:alice@example.com to:team@example.com subject:"Quarterly \\"Review\\"" hasattachments:false isread:false received>=2026-08-01 received<2026-08-04',
    });
  });

  it('builds an OData filter and escapes apostrophes', () => {
    expect(
      translateGraphQuery({
        from: "o'hara@example.com",
        to: "sales'o@example.com",
        subject: "Director's update",
        unreadOnly: true,
        hasAttachment: true,
        after: '2026-01-02',
        before: '2026-12-31T18:00:00.000Z',
      }),
    ).toEqual({
      mode: 'filter',
      filter:
        "from/emailAddress/address eq 'o''hara@example.com' and toRecipients/any(recipient:recipient/emailAddress/address eq 'sales''o@example.com') and contains(subject, 'Director''s update') and isRead eq false and hasAttachments eq true and receivedDateTime ge 2026-01-02T00:00:00Z and receivedDateTime lt 2026-12-31T00:00:00Z",
      orderby: 'receivedDateTime desc',
    });
  });

  it('formats search and filter date bounds consistently', () => {
    expect(
      translateGraphQuery({ text: 'renewal', after: '2026-02-03', before: '2026-02-05' }),
    ).toEqual({
      mode: 'search',
      search: 'renewal received>=2026-02-03 received<2026-02-05',
    });
    expect(translateGraphQuery({ after: '2026-02-03', before: '2026-02-05' })).toEqual({
      mode: 'filter',
      filter:
        'receivedDateTime ge 2026-02-03T00:00:00Z and receivedDateTime lt 2026-02-05T00:00:00Z',
      orderby: 'receivedDateTime desc',
    });
  });

  it.each([
    ['inbox', '/me/mailFolders/inbox/messages'],
    ['sent', '/me/mailFolders/sentitems/messages'],
    ['drafts', '/me/mailFolders/drafts/messages'],
    ['archive', '/me/mailFolders/archive/messages'],
    ['all', '/me/messages'],
    [undefined, '/me/messages'],
  ] as const)('maps the %s folder', (folder, expected) => {
    expect(folderPath(folder)).toBe(expected);
  });

  it('never emits a prohibited operation name', () => {
    const translations = [
      translateGraphQuery({ text: 'customer success', from: 'alice@example.com' }),
      translateGraphQuery({ subject: 'Quarterly review', hasAttachment: true }),
    ];
    const deliveryOperation = ['send', 'Mail'].join('');
    for (const translation of translations) {
      const output = JSON.stringify(translation);
      expect(output).not.toContain(deliveryOperation);
      expect(output.toLowerCase()).not.toContain('reply');
    }
  });
});
