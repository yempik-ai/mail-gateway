// Read-only draft operations: campaign listings and the status of one draft,
// including a liveness check against the provider.

import { GatewayError } from '@yempik/core';
import type { DraftServiceContext } from './context.js';
import { toGatewayFailure, withProviderTimeout } from './errors.js';
import { adapterForDraft } from './mailbox.js';
import { awaitsReconciliation } from './reconcile.js';
import { toDraftSummary } from './records.js';
import type {
  DraftStatusResult,
  DraftSummary,
  GetDraftStatusInput,
  ListCampaignDraftsInput,
} from './types.js';

export async function listCampaignDrafts(
  ctx: DraftServiceContext,
  input: ListCampaignDraftsInput,
): Promise<DraftSummary[]> {
  const rows = await ctx.store.listCampaignDrafts(input.campaignId, input.status);
  return rows.map(toDraftSummary);
}

export async function getDraftStatus(
  ctx: DraftServiceContext,
  input: GetDraftStatusInput,
): Promise<DraftStatusResult> {
  const { store, correlationId, timeoutMs, now } = ctx;
  const record = await store.findDraftById(input.internalDraftId);
  if (record === undefined) {
    throw new GatewayError('DRAFT_NOT_FOUND', `No gateway draft ${input.internalDraftId}`, {
      retryable: false,
      correlationId,
    });
  }
  const summary = toDraftSummary(record);
  // An uncertain send blocks every other draft tool until it is settled, so
  // the status answer names the only operation that can settle it.
  const hint: Pick<DraftStatusResult, 'reconciliationHint'> = awaitsReconciliation(
    ctx,
    record,
    now(),
  )
    ? {
        reconciliationHint: `This draft is waiting for reconcile_draft_send: its send outcome is unknown and no other tool can settle it. An outcome of "not_sent" makes it sendable again.`,
      }
    : {};
  if (
    record.status === 'deleted' ||
    record.status === 'sent' ||
    record.providerDraftId === undefined
  ) {
    return { ...summary, ...hint, stillExists: false };
  }

  try {
    const adapter = await adapterForDraft(ctx, record);
    await withProviderTimeout(
      adapter.getDraft(record.providerDraftId),
      timeoutMs,
      record.mailboxId,
      correlationId,
    );
    return { ...summary, ...hint, stillExists: true };
  } catch (error) {
    const gatewayError = toGatewayFailure(error, correlationId);
    // A provider 404 is an answer, not a failure: the draft was removed from
    // the mailbox by hand. Anything else leaves the row's existence unproven.
    if (gatewayError.code === 'DRAFT_NOT_FOUND' || gatewayError.code === 'MESSAGE_NOT_FOUND') {
      return {
        ...summary,
        ...hint,
        stillExists: false,
        providerCheckErrorCode: gatewayError.code,
      };
    }
    return { ...summary, ...hint, stillExists: true, providerCheckErrorCode: gatewayError.code };
  }
}
