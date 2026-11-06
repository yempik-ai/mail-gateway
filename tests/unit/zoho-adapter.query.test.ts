import { describe, expect, it } from 'vitest';
import {
  encodeMessageRef,
  parseMessageRef,
  translateZohoSearchKey,
} from '../../packages/zoho-adapter/src/index.js';

describe('translateZohoSearchKey', () => {
  it('returns undefined when nothing maps onto the search grammar', () => {
    expect(translateZohoSearchKey({})).toBeUndefined();
    expect(translateZohoSearchKey({ folder: 'inbox', unreadOnly: true })).toBeUndefined();
  });

  it('joins conditions with the AND separator', () => {
    expect(translateZohoSearchKey({ from: 'alice@example.com', subject: 'Proposal' })).toBe(
      'from:alice@example.com::subject:Proposal',
    );
  });

  it('maps free text onto the entire-message operator', () => {
    expect(translateZohoSearchKey({ text: 'follow up' })).toBe('entire:follow up');
  });

  it('only adds the attachment condition when attachments are required', () => {
    expect(translateZohoSearchKey({ text: 'x', hasAttachment: true })).toBe(
      'entire:x::has:attachment',
    );
    expect(translateZohoSearchKey({ text: 'x', hasAttachment: false })).toBe('entire:x');
  });

  it('defuses a double colon inside a term so it cannot start a new condition', () => {
    expect(translateZohoSearchKey({ text: 'note::from:ceo@rival.com' })).toBe(
      'entire:note: :from:ceo@rival.com',
    );
  });
});

describe('message references', () => {
  it('round-trips a folder and message id', () => {
    const ref = { folderId: '900', messageId: '17098761' };
    expect(parseMessageRef(encodeMessageRef(ref))).toEqual(ref);
  });

  it('rejects a bare message id', () => {
    expect(parseMessageRef('17098761')).toBeUndefined();
    expect(parseMessageRef(':17098761')).toBeUndefined();
    expect(parseMessageRef('900:')).toBeUndefined();
  });
});
