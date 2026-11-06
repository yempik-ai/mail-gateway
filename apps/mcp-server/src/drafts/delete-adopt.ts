// Bringing provider drafts under gateway management (adoption) and removing
// gateway drafts from the mailbox, one at a time or in a batch.

import { BATCH_BUDGET_FAILURE, startBatchBudget } from './batch-budget.js';
import { requireSendingIdentity, sendingIdentityFor } from './compose.js';
import { MAX_ADOPTIONS_PER_CALL, MAX_DELETIONS_PER_CALL } from './constants.js';
import type { DraftServiceContext } from './context.js';
import { invalid, toGatewayFailure, withProviderTimeout } from './errors.js';
import { claimDraftRow } from './idempotency.js';
import {
  adapterForDraft,
  requireAdapter,
  requireGatewayDraft,
  requireUsableMailbox,
} from './mailbox.js';
import { isLiveDraft, messageReferenceOf, normalizeRecipient, toDraftSummary } from './records.js';
import type {
  AdoptExternalDraftOutcome,
  AdoptExternalDraftsInput,
  AdoptExternalDraftsResult,
  DeleteOutreachDraftInput,
  DeleteOutreachDraftsInput,
  DeleteOutreachDraftsResult,
  DraftRecord,
  DraftSummary,
} from './types.js';

export async function adoptExternalDrafts(
  ctx: DraftServiceContext,
  input: AdoptExternalDraftsInput,
): Promise<AdoptExternalDraftsResult> {
  const { store, correlationId, timeoutMs, now } = ctx;
  if (input.providerMessageIds.length === 0) {
    throw invalid('At least one providerMessageId is required', correlationId);
  }
  if (input.providerMessageIds.length > MAX_ADOPTIONS_PER_CALL) {
    throw invalid(
      `At most ${MAX_ADOPTIONS_PER_CALL} external drafts can be adopted per call`,
      correlationId,
    );
  }

  // Before the first await: the batch time budget runs from here.
  const budget = startBatchBudget(ctx);
  const mailbox = requireUsableMailbox(await store.listMailboxes(), input.mailboxId, correlationId);
  const adapter = requireAdapter(ctx, mailbox);
  if (input.campaignId !== undefined) await store.ensureCampaign(input.campaignId);

  const results: AdoptExternalDraftOutcome[] = [];
  for (const [index, providerMessageId] of input.providerMessageIds.entries()) {
    // Checked before the provider read and the claim, so an entry the budget
    // cannot cover leaves no `creating` row behind.
    if (!budget.canStartEntry()) {
      results.push({ index, providerMessageId, ...BATCH_BUDGET_FAILURE });
      continue;
    }
    let claimed: DraftRecord | undefined;
    try {
      const snapshot = await withProviderTimeout(
        adapter.getDraftByMessageId(providerMessageId),
        timeoutMs,
        mailbox.id,
        correlationId,
      );
      const managed = await store.findDraftByProviderDraftId(mailbox.id, snapshot.providerDraftId);
      if (managed !== undefined && isLiveDraft(managed.status)) {
        results.push({
          index,
          providerMessageId,
          status: 'alreadyManaged',
          draft: toDraftSummary(managed),
        });
        continue;
      }

      const normalizedSnapshot =
        snapshot.providerMessageId === undefined ? { ...snapshot, providerMessageId } : snapshot;
      const selectedFrom = requireSendingIdentity(mailbox, normalizedSnapshot.from, correlationId);
      const sendingIdentityEmail = sendingIdentityFor(mailbox, selectedFrom);

      if (managed !== undefined) {
        claimed = await store.reclaimDraft(managed.id);
        if (claimed === undefined) {
          results.push({
            index,
            providerMessageId,
            status: 'failed',
            errorCode: 'DUPLICATE_DRAFT',
          });
          continue;
        }
      }

      if (claimed === undefined) {
        const claim = await claimDraftRow(store, {
          idempotencyKey: `adopt:${mailbox.id}:${snapshot.providerDraftId}`,
          mailboxId: mailbox.id,
          provider: mailbox.provider,
          sendingIdentityEmail,
          ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
        });
        if ('conflict' in claim) {
          const raced = await store.findDraftByProviderDraftId(
            mailbox.id,
            snapshot.providerDraftId,
          );
          results.push({
            index,
            providerMessageId,
            ...(raced === undefined
              ? { status: 'failed' as const, errorCode: 'DUPLICATE_DRAFT' as const }
              : {
                  status: 'alreadyManaged' as const,
                  draft: toDraftSummary(raced),
                }),
          });
          continue;
        }
        if ('duplicate' in claim) {
          results.push({
            index,
            providerMessageId,
            status: 'alreadyManaged',
            draft: toDraftSummary(claim.duplicate),
          });
          continue;
        }
        claimed = claim.claimed;
      }

      const at = now();
      const finalized = await store.finalizeDraftCreation({
        draftId: claimed.id,
        mailboxId: mailbox.id,
        providerDraftId: normalizedSnapshot.providerDraftId,
        providerMessageId: normalizedSnapshot.providerMessageId,
        sendingIdentityEmail,
        recordDraftActivity: false,
        at,
        ...(normalizedSnapshot.providerWebUrl === undefined
          ? {}
          : { providerWebUrl: normalizedSnapshot.providerWebUrl }),
        messageReference: messageReferenceOf(normalizedSnapshot, {
          mailboxId: mailbox.id,
          at,
          ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
          ...(normalizedSnapshot.subject === undefined
            ? {}
            : { subject: normalizedSnapshot.subject }),
          ...(normalizedSnapshot.to?.[0] === undefined
            ? {}
            : { normalizedRecipient: normalizeRecipient(normalizedSnapshot.to[0]) }),
        }),
      });
      await store.recordDraftOperation({
        draftId: claimed.id,
        operation: 'adopt',
        status: 'succeeded',
        correlationId,
      });
      results.push({
        index,
        providerMessageId,
        status: 'adopted',
        draft: toDraftSummary(finalized),
      });
    } catch (error) {
      const failure = toGatewayFailure(error, correlationId);
      if (claimed !== undefined) {
        await store.markDraftFailed(claimed.id, failure.code);
        await store.recordDraftOperation({
          draftId: claimed.id,
          operation: 'adopt',
          status: 'failed',
          correlationId,
          errorCode: failure.code,
        });
      }
      results.push({ index, providerMessageId, status: 'failed', errorCode: failure.code });
    }
  }

  return {
    mailboxId: mailbox.id,
    results,
    summary: {
      requested: results.length,
      adopted: results.filter((result) => result.status === 'adopted').length,
      alreadyManaged: results.filter((result) => result.status === 'alreadyManaged').length,
      failed: results.filter((result) => result.status === 'failed').length,
    },
  };
}

export async function deleteOutreachDraft(
  ctx: DraftServiceContext,
  input: DeleteOutreachDraftInput,
): Promise<DraftSummary> {
  const { store, correlationId, timeoutMs } = ctx;
  const record = await requireGatewayDraft(ctx, input.internalDraftId);
  const providerDraftId = record.providerDraftId ?? '';
  try {
    const adapter = await adapterForDraft(ctx, record);
    await withProviderTimeout(
      adapter.deleteDraft(providerDraftId),
      timeoutMs,
      record.mailboxId,
      correlationId,
    );
    const deleted = await store.markDraftDeleted(record.id);
    await store.recordDraftOperation({
      draftId: record.id,
      operation: 'delete',
      status: 'succeeded',
      correlationId,
    });
    return toDraftSummary(deleted);
  } catch (error) {
    const gatewayError = toGatewayFailure(error, correlationId);
    if (gatewayError.code === 'DRAFT_NOT_FOUND' || gatewayError.code === 'MESSAGE_NOT_FOUND') {
      const deleted = await store.markDraftDeleted(record.id);
      await store.recordDraftOperation({
        draftId: record.id,
        operation: 'delete',
        status: 'succeeded',
        correlationId,
      });
      return toDraftSummary(deleted);
    }
    await store.recordDraftOperation({
      draftId: record.id,
      operation: 'delete',
      status: 'failed',
      correlationId,
      errorCode: gatewayError.code,
    });
    throw gatewayError;
  }
}

export async function deleteOutreachDrafts(
  ctx: DraftServiceContext,
  input: DeleteOutreachDraftsInput,
): Promise<DeleteOutreachDraftsResult> {
  const { correlationId } = ctx;
  if (input.internalDraftIds.length === 0) {
    throw invalid('At least one internalDraftId is required', correlationId);
  }
  if (input.internalDraftIds.length > MAX_DELETIONS_PER_CALL) {
    throw invalid(
      `At most ${MAX_DELETIONS_PER_CALL} drafts can be deleted per call`,
      correlationId,
    );
  }

  const budget = startBatchBudget(ctx);
  const results: DeleteOutreachDraftsResult['results'] = [];
  for (const [index, internalDraftId] of input.internalDraftIds.entries()) {
    if (!budget.canStartEntry()) {
      results.push({ index, internalDraftId, ...BATCH_BUDGET_FAILURE });
      continue;
    }
    try {
      const draft = await deleteOutreachDraft(ctx, { internalDraftId });
      results.push({ index, internalDraftId, status: 'deleted', draft });
    } catch (error) {
      results.push({
        index,
        internalDraftId,
        status: 'failed',
        errorCode: toGatewayFailure(error, correlationId).code,
      });
    }
  }

  return {
    results,
    summary: {
      requested: results.length,
      deleted: results.filter((result) => result.status === 'deleted').length,
      failed: results.filter((result) => result.status === 'failed').length,
    },
  };
}
