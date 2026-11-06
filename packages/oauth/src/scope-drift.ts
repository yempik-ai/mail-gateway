import type { MailboxProvider } from '@yempik/core';

/**
 * Scopes a stored grant must carry before the gateway can deliver a draft from
 * that mailbox.
 *
 * An OAuth grant is frozen at consent time: `oauth_connections.scopes` records
 * what the operator actually approved, and widening the scope list the gateway
 * *requests* never reopens an existing grant. Both Outlook mailboxes were
 * consented before `Mail.Send` was requested, so they stayed `connected` and
 * kept reading normally while being unable to send. Comparing the stored grant
 * against this list turns that silent gap into something visible before a send
 * instead of a failure during one.
 */
export const DELIVERY_CRITICAL_SCOPES: Record<MailboxProvider, readonly string[]> = {
  // gmail.compose covers both managing and delivering an existing draft, so it
  // is the only Google scope delivery depends on (gmail.readonly is read-only).
  gmail: ['https://www.googleapis.com/auth/gmail.compose'],
  // Declared Graph-qualified, as MICROSOFT_GRAPH_SCOPES requests them. Entra
  // echoes scopes bare on some endpoints and qualified on others, and
  // `missingDeliveryScopes` accepts either spelling.
  microsoft: [
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/Mail.Send',
  ],
  // Zoho has no scope separating "save a draft" from "send": both go through
  // POST /messages under ZohoMail.messages.CREATE.
  zoho: ['ZohoMail.messages.CREATE'],
};

const GRAPH_SCOPE_PREFIX = 'https://graph.microsoft.com/';

/** Bare and Graph-qualified spellings of a Microsoft scope are the same grant. */
function normalizeScope(scope: string): string {
  const trimmed = scope.trim();
  const bare = trimmed.startsWith(GRAPH_SCOPE_PREFIX)
    ? trimmed.slice(GRAPH_SCOPE_PREFIX.length)
    : trimmed;
  return bare.toLowerCase();
}

/**
 * Delivery-critical scopes the grant does not carry, in their canonical
 * spelling. An empty result means the grant can send; an empty `grantedScopes`
 * therefore reports every scope as missing.
 */
export function missingDeliveryScopes(
  provider: MailboxProvider,
  grantedScopes: readonly string[],
): string[] {
  const granted = new Set(grantedScopes.map(normalizeScope));
  return DELIVERY_CRITICAL_SCOPES[provider].filter(
    (required) => !granted.has(normalizeScope(required)),
  );
}
