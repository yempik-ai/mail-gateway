import { describe, expect, it } from 'vitest';
import { DELIVERY_CRITICAL_SCOPES, missingDeliveryScopes } from '../../packages/oauth/src/index.js';

describe('missingDeliveryScopes', () => {
  it('accepts Microsoft scopes echoed bare', () => {
    expect(
      missingDeliveryScopes('microsoft', ['openid', 'profile', 'Mail.ReadWrite', 'Mail.Send']),
    ).toEqual([]);
  });

  it('accepts Microsoft scopes echoed Graph-qualified', () => {
    expect(
      missingDeliveryScopes('microsoft', [
        'https://graph.microsoft.com/Mail.ReadWrite',
        'https://graph.microsoft.com/Mail.Send',
        'offline_access',
      ]),
    ).toEqual([]);
  });

  it('reports the grant frozen before Mail.Send was requested', () => {
    // The exact grant both Outlook mailboxes carry in production.
    expect(
      missingDeliveryScopes('microsoft', ['openid', 'profile', 'email', 'Mail.ReadWrite']),
    ).toEqual(['https://graph.microsoft.com/Mail.Send']);
  });

  it('accepts a Gmail grant that carries gmail.compose', () => {
    expect(
      missingDeliveryScopes('gmail', [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ]),
    ).toEqual([]);
  });

  it('reports a Gmail read-only grant as unable to deliver', () => {
    expect(
      missingDeliveryScopes('gmail', ['https://www.googleapis.com/auth/gmail.readonly']),
    ).toEqual(['https://www.googleapis.com/auth/gmail.compose']);
  });

  it('reports a Zoho grant without messages.CREATE', () => {
    expect(
      missingDeliveryScopes('zoho', ['ZohoMail.accounts.READ', 'ZohoMail.messages.READ']),
    ).toEqual(['ZohoMail.messages.CREATE']);
  });

  it('reports every delivery scope as missing when the grant records none', () => {
    for (const provider of ['gmail', 'microsoft', 'zoho'] as const) {
      expect(missingDeliveryScopes(provider, [])).toEqual([...DELIVERY_CRITICAL_SCOPES[provider]]);
    }
  });
});
