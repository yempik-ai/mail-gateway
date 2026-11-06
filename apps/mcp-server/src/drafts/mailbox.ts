// Guards that resolve what an operation acts on: a usable mailbox, its draft
// adapter, its delivery grant, and a draft row the gateway owns.

import { GatewayError } from '@yempik/core';
import type { GatewayErrorCode, MailDraftAdapter, MailboxProvider } from '@yempik/core';
import { missingDeliveryScopes } from '@yempik/oauth';
import type { DraftServiceContext } from './context.js';
import type { DraftMailboxRecord, DraftRecord } from './types.js';

/** Path segment of the `/oauth/<segment>/start` route that re-consents a provider. */
const OAUTH_START_ROUTE: Record<MailboxProvider, string> = {
  gmail: 'google',
  microsoft: 'microsoft',
  zoho: 'zoho',
};

export function requireAdapter(
  ctx: DraftServiceContext,
  mailbox: DraftMailboxRecord,
): MailDraftAdapter {
  const { draftAdapterFactory, correlationId } = ctx;
  const adapter = draftAdapterFactory(
    {
      id: mailbox.id,
      provider: mailbox.provider,
      emailAddress: mailbox.emailAddress,
      aliases: mailbox.aliases,
    },
    correlationId,
  );
  if (adapter === undefined) {
    throw new GatewayError(
      'UNSUPPORTED_OPERATION',
      `No draft adapter is configured for mailbox ${mailbox.id}`,
      { retryable: false, correlationId },
    );
  }
  return adapter;
}

export function requireUsableMailbox(
  rows: DraftMailboxRecord[],
  mailboxId: string,
  correlationId: string,
): DraftMailboxRecord {
  const row = rows.find((candidate) => candidate.id === mailboxId);
  const fail = (code: GatewayErrorCode, message: string): never => {
    throw new GatewayError(code, message, { retryable: false, correlationId });
  };
  if (row === undefined) return fail('MAILBOX_NOT_FOUND', `Mailbox ${mailboxId} is not registered`);
  if (!row.enabled) return fail('MAILBOX_DISABLED', `Mailbox ${mailboxId} is disabled`);
  if (row.connectionStatus !== 'connected') {
    return fail('AUTH_REQUIRED', `Mailbox ${mailboxId} requires reconnection`);
  }
  return row;
}

/**
 * Refuses a delivery the stored grant cannot perform. An OAuth grant keeps
 * the scopes consented when the mailbox was connected, so a mailbox can be
 * `connected`, read normally, and still be unable to send; only reconnecting
 * re-consents. Called before the send claims quota, so a refusal costs
 * nothing.
 */
export function requireDeliveryScopes(mailbox: DraftMailboxRecord, correlationId: string): void {
  const missing = missingDeliveryScopes(mailbox.provider, mailbox.grantedScopes);
  if (missing.length === 0) return;
  throw new GatewayError(
    'AUTH_REQUIRED',
    `Mailbox ${mailbox.id} (${mailbox.emailAddress}) cannot deliver: its OAuth grant is missing ${missing.join(', ')}. Reconnect it from /oauth/${OAUTH_START_ROUTE[mailbox.provider]}/start?mailboxId=${mailbox.id} to consent to the current scopes`,
    { retryable: false, correlationId },
  );
}

/** Only rows this gateway owns are addressable: the client never sends a provider id. */
export async function requireGatewayDraft(
  ctx: DraftServiceContext,
  internalDraftId: string,
): Promise<DraftRecord> {
  const { store, correlationId } = ctx;
  const record = await store.findDraftById(internalDraftId);
  if (record === undefined || (record.status !== 'created' && record.status !== 'updated')) {
    throw new GatewayError(
      'DRAFT_NOT_FOUND',
      `No gateway draft ${internalDraftId} is available for this operation`,
      { retryable: false, correlationId },
    );
  }
  if (record.providerDraftId === undefined) {
    throw new GatewayError(
      'DRAFT_NOT_FOUND',
      `Draft ${internalDraftId} has no provider draft to act on`,
      { retryable: false, correlationId },
    );
  }
  return record;
}

export async function adapterForDraft(
  ctx: DraftServiceContext,
  record: DraftRecord,
): Promise<MailDraftAdapter> {
  return requireAdapter(
    ctx,
    requireUsableMailbox(await ctx.store.listMailboxes(), record.mailboxId, ctx.correlationId),
  );
}
