// Creating gateway-owned drafts: outreach batches routed over the mailboxes,
// and single replies kept in the mailbox that holds the source message.

import { GatewayError } from '@yempik/core';
import type { GatewayErrorCode } from '@yempik/core';
import {
  bodyProblem,
  composeBody,
  rawDraftBody,
  requireSendingIdentity,
  sendingIdentityFor,
  type ComposedBody,
} from './compose.js';
import { startBatchBudget } from './batch-budget.js';
import { BATCH_TIME_BUDGET_EXCEEDED_MESSAGE, MAX_DRAFTS_PER_CALL } from './constants.js';
import type { DraftServiceContext } from './context.js';
import { invalid, toGatewayFailure, withProviderTimeout } from './errors.js';
import {
  claimDraftRow,
  contentHash,
  outreachIdempotencyKey,
  replyIdempotencyKey,
} from './idempotency.js';
import { requireAdapter, requireUsableMailbox } from './mailbox.js';
import {
  duplicateResult,
  isLiveDraft,
  isValidRecipient,
  messageReferenceOf,
  normalizeRecipient,
  usageDateOf,
} from './records.js';
import { createDraftRouter, routableMailboxes } from './routing.js';
import type {
  CreateOutreachDraftsInput,
  CreateOutreachDraftsResult,
  CreateReplyDraftInput,
  DraftResult,
} from './types.js';

export async function createOutreachDrafts(
  ctx: DraftServiceContext,
  input: CreateOutreachDraftsInput,
): Promise<CreateOutreachDraftsResult> {
  const { store, correlationId, timeoutMs, now } = ctx;
  if (input.drafts.length === 0) {
    throw invalid('At least one draft is required', correlationId);
  }
  if (input.drafts.length > MAX_DRAFTS_PER_CALL) {
    throw invalid(
      `At most ${MAX_DRAFTS_PER_CALL} drafts can be created per call, received ${input.drafts.length}`,
      correlationId,
    );
  }
  if (input.routingMode === 'explicit' && (input.mailboxId ?? '') === '') {
    throw invalid('mailboxId is required when routingMode is "explicit"', correlationId);
  }
  if (input.routingMode !== 'explicit' && input.fromAddress !== undefined) {
    throw invalid('fromAddress requires routingMode "explicit"', correlationId);
  }

  const sequenceStep = input.sequenceStep ?? 1;
  if (!Number.isInteger(sequenceStep) || sequenceStep < 1) {
    throw invalid('sequenceStep must be a positive integer', correlationId);
  }

  // Nothing has awaited yet, so this is the start of the call: the batch time
  // budget runs from here.
  const startedAt = now();
  const budget = startBatchBudget(ctx, startedAt);
  const usageDate = usageDateOf(startedAt);
  const mailboxRows = await store.listMailboxes();

  // Explicit mode validates the single target up front so an unusable mailbox
  // fails the whole call instead of every entry individually.
  const explicitTarget =
    input.routingMode === 'explicit'
      ? requireUsableMailbox(mailboxRows, input.mailboxId ?? '', correlationId)
      : undefined;
  const fromAddress =
    explicitTarget === undefined
      ? undefined
      : requireSendingIdentity(explicitTarget, input.fromAddress, correlationId);

  await store.ensureCampaign(input.campaignId);

  const [assignments, usage] = await Promise.all([
    store.listProspectAssignments(input.campaignId),
    store.dailyUsage(usageDate),
  ]);
  const assignedMailboxByRecipient = new Map(
    assignments.map((assignment) => [assignment.normalizedRecipientEmail, assignment.mailboxId]),
  );

  const candidatePool =
    explicitTarget === undefined ? routableMailboxes(mailboxRows) : [explicitTarget];
  const router = createDraftRouter(
    candidatePool.map((mailbox) => ({
      mailboxId: mailbox.id,
      perRunLimit: mailbox.perRunDraftLimit,
      dailyRemaining: Math.max(mailbox.dailyDraftLimit - (usage[mailbox.id] ?? 0), 0),
    })),
  );
  const byId = new Map(mailboxRows.map((mailbox) => [mailbox.id, mailbox]));

  const results: DraftResult[] = [];
  const seenKeys = new Set<string>();

  // Entries run one at a time on purpose. The round-robin cursor, the "first
  // entry owns a repeated recipient" rule and the per-run slots all follow
  // input order; running entries concurrently would let database latency
  // decide which mailbox and which entry win. The time budget below is what
  // keeps a slow provider from outliving the function.
  for (const [index, entry] of input.drafts.entries()) {
    const recipient = entry.to.trim();
    const normalized = normalizeRecipient(recipient);

    const failure = (errorCode: GatewayErrorCode, mailboxId?: string): DraftResult => ({
      index,
      recipient: normalized,
      status: 'failed',
      duplicatePrevented: false,
      errorCode,
      ...(mailboxId === undefined ? {} : { mailboxId }),
    });

    if (!isValidRecipient(recipient)) {
      results.push(failure('INVALID_RECIPIENT'));
      continue;
    }
    if (entry.subject.trim() === '') {
      results.push(failure('INVALID_QUERY'));
      continue;
    }
    if (bodyProblem(entry) !== undefined) {
      results.push(failure('INVALID_QUERY'));
      continue;
    }

    const idempotencyKey = outreachIdempotencyKey(input.campaignId, normalized, sequenceStep);
    if (seenKeys.has(idempotencyKey)) {
      // Same recipient twice in one batch: the first entry owns the draft.
      const existing = await store.findDraftByIdempotencyKey(idempotencyKey);
      results.push(
        existing === undefined
          ? failure('DUPLICATE_DRAFT')
          : duplicateResult(index, normalized, existing),
      );
      continue;
    }

    const known = await store.findDraftByIdempotencyKey(idempotencyKey);
    if (known !== undefined && isLiveDraft(known.status)) {
      seenKeys.add(idempotencyKey);
      results.push(duplicateResult(index, normalized, known));
      continue;
    }

    // Sticky routing: an already-assigned recipient keeps its mailbox forever, in
    // every following step of the campaign. It is never rerouted: when its
    // mailbox is unusable or out of capacity, this entry fails instead.
    const stickyMailboxId =
      input.routingMode === 'distributed' ? assignedMailboxByRecipient.get(normalized) : undefined;
    if (stickyMailboxId !== undefined) {
      const sticky = byId.get(stickyMailboxId);
      if (sticky === undefined) {
        results.push(failure('MAILBOX_NOT_FOUND', stickyMailboxId));
        continue;
      }
      if (!sticky.enabled) {
        results.push(failure('MAILBOX_DISABLED', stickyMailboxId));
        continue;
      }
      if (sticky.connectionStatus !== 'connected') {
        results.push(failure('AUTH_REQUIRED', stickyMailboxId));
        continue;
      }
    }

    // Capacity is only consumed by entries that really reach a provider.
    const allocation =
      stickyMailboxId === undefined ? router.next() : router.reserve(stickyMailboxId);
    if ('errorCode' in allocation) {
      results.push(failure(allocation.errorCode, stickyMailboxId));
      continue;
    }

    const mailbox = byId.get(allocation.mailboxId);
    if (mailbox === undefined) {
      results.push(failure('MAILBOX_NOT_FOUND', allocation.mailboxId));
      continue;
    }

    // The function hosting this call is killed at its platform limit, and a
    // kill between claim and finalize strands a `creating` row. An entry
    // therefore starts only while the budget still covers a full provider
    // timeout plus the writes around it; otherwise it fails retryably before
    // claiming anything, and its slot goes back like a compose failure's.
    if (!budget.canStartEntry()) {
      router.release(mailbox.id);
      results.push({
        ...failure('BATCH_TIME_BUDGET_EXCEEDED', mailbox.id),
        errorMessage: BATCH_TIME_BUDGET_EXCEEDED_MESSAGE,
      });
      continue;
    }

    // Composed before the claim: a signature lookup failure must not leave a
    // `creating` row behind. Signing happens per entry because distributed
    // routing gives each entry its own mailbox, hence its own identity, so
    // it can only run once the router picked one. A failure here (INVALID_QUERY
    // body, DATABASE_ERROR signature registry) fails this entry alone: earlier
    // entries already created provider drafts, and aborting the batch would
    // hide their results. The slot goes back since no provider was reached.
    let composed: ComposedBody;
    try {
      composed = await composeBody(
        ctx,
        mailbox,
        fromAddress,
        entry,
        input.includeSignature ?? true,
      );
    } catch (error) {
      router.release(mailbox.id);
      results.push(failure(toGatewayFailure(error, correlationId).code, mailbox.id));
      continue;
    }

    const prospectId = entry.prospectId ?? normalized;
    const claim = await claimDraftRow(store, {
      idempotencyKey,
      mailboxId: mailbox.id,
      provider: mailbox.provider,
      sendingIdentityEmail: sendingIdentityFor(mailbox, fromAddress),
      campaignId: input.campaignId,
      prospectId,
      normalizedRecipientEmail: normalized,
      sequenceStep,
    });
    seenKeys.add(idempotencyKey);

    if ('conflict' in claim) {
      results.push(failure('DUPLICATE_DRAFT', mailbox.id));
      continue;
    }
    if ('duplicate' in claim) {
      results.push(duplicateResult(index, normalized, claim.duplicate));
      continue;
    }

    const row = claim.claimed;
    try {
      const adapter = requireAdapter(ctx, mailbox);
      const snapshot = await withProviderTimeout(
        adapter.createDraft({
          to: [recipient],
          ...(composed.from === undefined ? {} : { from: composed.from }),
          ...(composed.fromDisplayName === undefined
            ? {}
            : { fromDisplayName: composed.fromDisplayName }),
          subject: entry.subject,
          textBody: composed.textBody,
          htmlBody: composed.htmlBody,
        }),
        timeoutMs,
        mailbox.id,
        correlationId,
      );

      const at = now();
      const finalized = await store.finalizeDraftCreation({
        draftId: row.id,
        mailboxId: mailbox.id,
        providerDraftId: snapshot.providerDraftId,
        sendingIdentityEmail: sendingIdentityFor(mailbox, fromAddress),
        usageDate,
        at,
        ...(snapshot.providerMessageId === undefined
          ? {}
          : { providerMessageId: snapshot.providerMessageId }),
        ...(snapshot.providerWebUrl === undefined
          ? {}
          : { providerWebUrl: snapshot.providerWebUrl }),
        messageReference: messageReferenceOf(snapshot, {
          mailboxId: mailbox.id,
          campaignId: input.campaignId,
          prospectId,
          normalizedRecipient: normalized,
          subject: entry.subject,
          at,
        }),
      });

      await store.saveProspectAssignment({
        campaignId: input.campaignId,
        prospectId,
        normalizedRecipientEmail: normalized,
        mailboxId: mailbox.id,
      });
      await store.recordDraftOperation({
        draftId: row.id,
        operation: 'create',
        status: 'succeeded',
        correlationId,
      });

      results.push({
        index,
        recipient: normalized,
        internalDraftId: finalized.id,
        mailboxId: mailbox.id,
        provider: mailbox.provider,
        sendingIdentityEmail: sendingIdentityFor(mailbox, fromAddress),
        status: 'created',
        duplicatePrevented: false,
        providerDraftId: snapshot.providerDraftId,
        ...(snapshot.providerMessageId === undefined
          ? {}
          : { providerMessageId: snapshot.providerMessageId }),
        ...(snapshot.providerWebUrl === undefined
          ? {}
          : { providerWebUrl: snapshot.providerWebUrl }),
      });
    } catch (error) {
      const gatewayError = toGatewayFailure(error, correlationId);
      await store.markDraftFailed(row.id, gatewayError.code);
      await store.recordDraftOperation({
        draftId: row.id,
        operation: 'create',
        status: 'failed',
        correlationId,
        errorCode: gatewayError.code,
      });
      results.push({
        index,
        recipient: normalized,
        internalDraftId: row.id,
        mailboxId: mailbox.id,
        provider: mailbox.provider,
        status: 'failed',
        duplicatePrevented: false,
        errorCode: gatewayError.code,
      });
    }
  }

  const byMailbox: Record<string, number> = {};
  for (const result of results) {
    if (result.status !== 'created' || result.mailboxId === undefined) continue;
    byMailbox[result.mailboxId] = (byMailbox[result.mailboxId] ?? 0) + 1;
  }

  return {
    campaignId: input.campaignId,
    sequenceStep,
    routingMode: input.routingMode,
    results,
    summary: {
      requested: input.drafts.length,
      created: results.filter((result) => result.status === 'created').length,
      duplicates: results.filter((result) => result.status === 'duplicate').length,
      failed: results.filter((result) => result.status === 'failed').length,
      byMailbox,
    },
  };
}

export async function createReplyDraft(
  ctx: DraftServiceContext,
  input: CreateReplyDraftInput,
): Promise<DraftResult> {
  const { store, correlationId, quoteTimeZone, timeoutMs, now } = ctx;
  const problem = bodyProblem(input);
  if (problem !== undefined) throw invalid(problem, correlationId);

  // A reply lives in the mailbox that holds the source message.
  // There is deliberately no way for the caller to redirect it elsewhere.
  const mailbox = requireUsableMailbox(await store.listMailboxes(), input.mailboxId, correlationId);
  const fromAddress = requireSendingIdentity(mailbox, input.fromAddress, correlationId);
  if (input.campaignId !== undefined) await store.ensureCampaign(input.campaignId);

  const idempotencyKey = replyIdempotencyKey(input);
  const hash = contentHash(rawDraftBody(input));
  // The claim needs only the raw-body hash; the body is composed after it so
  // an idempotent retry answers 'duplicate' without rendering or reading the
  // signature registry, and a registry outage cannot turn it into an error.
  const claim = await claimDraftRow(store, {
    idempotencyKey,
    mailboxId: mailbox.id,
    provider: mailbox.provider,
    sendingIdentityEmail: sendingIdentityFor(mailbox, fromAddress),
    sourceMessageId: input.sourceMessageId,
    contentHash: hash,
    ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
    ...(input.prospectId === undefined ? {} : { prospectId: input.prospectId }),
  });

  if ('conflict' in claim) {
    throw new GatewayError('DUPLICATE_DRAFT', 'A reply draft already exists for this message', {
      retryable: false,
      correlationId,
    });
  }
  if ('duplicate' in claim) return duplicateResult(0, input.sourceMessageId, claim.duplicate);

  const row = claim.claimed;
  try {
    // Inside the try: a compose failure marks the claimed row failed like an
    // adapter failure does, so a retry can reclaim the key.
    const composed = await composeBody(
      ctx,
      mailbox,
      fromAddress,
      input,
      input.includeSignature ?? true,
    );
    const adapter = requireAdapter(ctx, mailbox);
    const snapshot = await withProviderTimeout(
      adapter.createReplyDraft({
        sourceMessageId: input.sourceMessageId,
        replyMode: input.replyMode,
        ...(composed.from === undefined ? {} : { from: composed.from }),
        ...(composed.fromDisplayName === undefined
          ? {}
          : { fromDisplayName: composed.fromDisplayName }),
        textBody: composed.textBody,
        htmlBody: composed.htmlBody,
        // The signature is already in the body; the adapter puts the
        // original below it, the way mail clients lay out a reply.
        quoteOriginal: true,
        ...(quoteTimeZone === undefined ? {} : { quoteTimeZone }),
      }),
      timeoutMs,
      mailbox.id,
      correlationId,
    );

    const at = now();
    const finalized = await store.finalizeDraftCreation({
      draftId: row.id,
      mailboxId: mailbox.id,
      providerDraftId: snapshot.providerDraftId,
      sendingIdentityEmail: sendingIdentityFor(mailbox, fromAddress),
      at,
      ...(snapshot.providerMessageId === undefined
        ? {}
        : { providerMessageId: snapshot.providerMessageId }),
      ...(snapshot.providerWebUrl === undefined ? {} : { providerWebUrl: snapshot.providerWebUrl }),
      messageReference: messageReferenceOf(snapshot, {
        mailboxId: mailbox.id,
        contentHash: hash,
        at,
        ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
        ...(input.prospectId === undefined ? {} : { prospectId: input.prospectId }),
        ...(snapshot.subject === undefined ? {} : { subject: snapshot.subject }),
      }),
    });
    await store.recordDraftOperation({
      draftId: row.id,
      operation: 'reply_create',
      status: 'succeeded',
      correlationId,
    });

    return {
      index: 0,
      recipient: input.sourceMessageId,
      internalDraftId: finalized.id,
      mailboxId: mailbox.id,
      provider: mailbox.provider,
      sendingIdentityEmail: sendingIdentityFor(mailbox, fromAddress),
      status: 'created',
      duplicatePrevented: false,
      providerDraftId: snapshot.providerDraftId,
      ...(snapshot.providerMessageId === undefined
        ? {}
        : { providerMessageId: snapshot.providerMessageId }),
      ...(snapshot.providerWebUrl === undefined ? {} : { providerWebUrl: snapshot.providerWebUrl }),
    };
  } catch (error) {
    const gatewayError = toGatewayFailure(error, correlationId);
    await store.markDraftFailed(row.id, gatewayError.code);
    await store.recordDraftOperation({
      draftId: row.id,
      operation: 'reply_create',
      status: 'failed',
      correlationId,
      errorCode: gatewayError.code,
    });
    throw gatewayError;
  }
}
