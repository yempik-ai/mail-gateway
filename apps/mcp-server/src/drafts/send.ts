// Autonomous delivery of a gateway draft: claim the row and the send quota,
// call the provider once, then settle the claim as sent, released or unknown.
//
//   created|updated --claim--> sending --accepted--> sent
//                                      --rejected--> created|updated (quota back)
//                                      --uncertain-> send_unknown (reconcile.ts)

import { GatewayError } from '@yempik/core';
import type { DraftServiceContext } from './context.js';
import { toGatewayFailure, withProviderTimeout } from './errors.js';
import { requireAdapter, requireDeliveryScopes, requireUsableMailbox } from './mailbox.js';
import { toDraftSummary, usageDateOf } from './records.js';
import type { DraftRecord, SendDraftInput, SendDraftResult } from './types.js';

function sentResult(record: DraftRecord, alreadySent: boolean): SendDraftResult {
  return {
    ...toDraftSummary(record),
    status: 'sent',
    alreadySent,
    ...(record.sentAt === undefined ? {} : { acceptedAt: record.sentAt }),
  };
}

export async function sendDraft(
  ctx: DraftServiceContext,
  input: SendDraftInput,
): Promise<SendDraftResult> {
  const { store, correlationId, timeoutMs, now } = ctx;
  const existing = await store.findDraftById(input.internalDraftId);
  if (existing?.status === 'sent') return sentResult(existing, true);
  if (existing?.status === 'sending' || existing?.status === 'send_unknown') {
    throw new GatewayError(
      'SEND_STATUS_UNKNOWN',
      `Draft ${input.internalDraftId} may already have been accepted; do not retry automatically; call reconcile_draft_send to settle it`,
      { retryable: false, correlationId },
    );
  }
  if (
    existing === undefined ||
    (existing.status !== 'created' && existing.status !== 'updated') ||
    existing.providerDraftId === undefined
  ) {
    throw new GatewayError(
      'DRAFT_NOT_FOUND',
      `No sendable gateway draft ${input.internalDraftId}`,
      {
        retryable: false,
        correlationId,
      },
    );
  }

  const mailbox = requireUsableMailbox(
    await store.listMailboxes(),
    existing.mailboxId,
    correlationId,
  );
  requireDeliveryScopes(mailbox, correlationId);
  const adapter = requireAdapter(ctx, mailbox);
  const startedAt = now();
  const usageDate = usageDateOf(startedAt);
  const claim = await store.claimDraftForSending(existing.id, usageDate, startedAt);
  if (claim.status === 'daily_limit') {
    throw new GatewayError(
      'DAILY_LIMIT_REACHED',
      `Mailbox ${existing.mailboxId} reached its daily send limit`,
      { retryable: false, correlationId },
    );
  }
  if (claim.status === 'not_claimable') {
    const settled = claim.draft ?? (await store.findDraftById(existing.id));
    if (settled?.status === 'sent') return sentResult(settled, true);
    throw new GatewayError(
      'SEND_STATUS_UNKNOWN',
      `Draft ${existing.id} is already being sent or has an uncertain send result; call reconcile_draft_send to settle it`,
      { retryable: false, correlationId },
    );
  }

  let providerAccepted = false;
  try {
    const receipt = await withProviderTimeout(
      adapter.sendDraft(existing.providerDraftId),
      timeoutMs,
      existing.mailboxId,
      correlationId,
    );
    providerAccepted = true;
    const sent = await store.finalizeDraftSend(existing.id, receipt, now());
    await store.recordDraftOperation({
      draftId: existing.id,
      operation: 'send',
      status: 'succeeded',
      correlationId,
    });
    return sentResult(sent, false);
  } catch (error) {
    const providerError = toGatewayFailure(error, correlationId);
    const uncertain =
      providerAccepted ||
      providerError.code === 'PROVIDER_TIMEOUT' ||
      providerError.code === 'PROVIDER_UNAVAILABLE' ||
      providerError.code === 'DATABASE_ERROR' ||
      providerError.code === 'INTERNAL_ERROR';
    // If persistence is temporarily unavailable, the row remains `sending`.
    // That state is itself fail-closed and prevents a duplicate provider call.
    await store
      .releaseDraftSend({
        draftId: existing.id,
        usageDate,
        previousStatus: claim.previousStatus,
        errorCode: uncertain ? 'SEND_STATUS_UNKNOWN' : providerError.code,
        uncertain,
        at: now(),
      })
      .catch(() => undefined);
    await store.recordDraftOperation({
      draftId: existing.id,
      operation: 'send',
      status: 'failed',
      correlationId,
      errorCode: uncertain ? 'SEND_STATUS_UNKNOWN' : providerError.code,
    });
    if (!uncertain) throw providerError;
    // The tool layer serializes code and message only, so the provider's
    // own words must travel in the message or the operator never sees them.
    throw new GatewayError(
      'SEND_STATUS_UNKNOWN',
      `The provider may have accepted draft ${existing.id}; automatic retry is blocked; call reconcile_draft_send to settle it (${providerError.code}: ${providerError.message})`,
      { retryable: false, correlationId, cause: providerError },
    );
  }
}
