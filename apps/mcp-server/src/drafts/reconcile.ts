// Settling a send whose outcome `sendDraft` could not observe, from the
// evidence the mailbox itself holds (Drafts and Sent folders).

import { GatewayError } from '@yempik/core';
import type {
  MailDraftAdapter,
  MailProviderAdapter,
  MailboxProvider,
  NormalizedEmail,
} from '@yempik/core';
import {
  RECONCILE_CLOCK_SKEW_MS,
  RECONCILE_SEARCH_LIMIT,
  ZOHO_NOT_SENT_MIN_AGE_MS,
} from './constants.js';
import type { DraftServiceContext } from './context.js';
import { invalid, toGatewayFailure, withProviderTimeout } from './errors.js';
import { adapterForDraft } from './mailbox.js';
import { normalizeRecipient, toDraftSummary, usageDateOf } from './records.js';
import type {
  DraftRecord,
  ReconcileDraftSendInput,
  ReconcileDraftSendResult,
  ReconcileSendEvidence,
  ReconcileSendOutcome,
} from './types.js';

/** Epoch millis of the moment the row was last written, i.e. its send claim. */
function claimedAtOf(record: DraftRecord): number | undefined {
  const parsed = record.updatedAt === undefined ? Number.NaN : Date.parse(record.updatedAt);
  return Number.isNaN(parsed) ? undefined : parsed;
}

type SearchCapableDraftAdapter = MailDraftAdapter & Pick<MailProviderAdapter, 'searchEmails'>;

/**
 * The composition root wires one adapter object per mailbox that satisfies both
 * the read and the draft contract, but `DraftAdapterFactory` only promises the
 * draft half. Sent evidence is therefore optional rather than a second factory.
 */
function supportsSentSearch(adapter: MailDraftAdapter): adapter is SearchCapableDraftAdapter {
  return typeof (adapter as Partial<MailProviderAdapter>).searchEmails === 'function';
}

/** Providers re-wrap and re-case subject headers; comparison must not. */
function normalizeSubject(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/gu, ' ');
}

/**
 * A Sent copy proves delivery when it carries the same recipient and subject
 * and is not older than the claim. A message the provider dates imprecisely
 * still counts: reporting `sent` too eagerly withholds one message, reporting
 * `not_sent` too eagerly risks delivering the same message twice.
 */
function isSentCopy(
  email: NormalizedEmail,
  target: { recipient: string; subject: string; notBefore: number | undefined },
): boolean {
  if (normalizeSubject(email.subject) !== normalizeSubject(target.subject)) return false;
  if (!email.to.some((address) => normalizeRecipient(address.address) === target.recipient)) {
    return false;
  }
  if (target.notBefore === undefined) return true;
  const messageAt = Date.parse(email.sentAt ?? email.receivedAt ?? '');
  return Number.isNaN(messageAt) || messageAt >= target.notBefore;
}

/**
 * The reconciliation decision table. A Sent copy is proof of delivery for every
 * provider. Absence of one is proof of non-delivery only where the provider
 * also tells us the draft survived: Gmail and Microsoft consume the draft on
 * send, so a draft still in Drafts settles it; Zoho sends a separate message and
 * the gateway removes the draft afterwards, so there only an aged, empty Sent
 * folder settles it. Everything else stays `unresolved` and leaves the row alone.
 */
function decideReconcileOutcome(
  provider: MailboxProvider,
  evidence: ReconcileSendEvidence,
  ageMs: number | undefined,
): { outcome: ReconcileSendOutcome; reason?: string } {
  if (evidence.sentMatchFound === true) return { outcome: 'sent' };
  if (evidence.sentMatchFound === undefined) {
    return { outcome: 'unresolved', reason: 'the Sent folder could not be searched' };
  }
  if (provider === 'gmail' || provider === 'microsoft') {
    if (evidence.draftStillPresent === true) return { outcome: 'not_sent' };
    return {
      outcome: 'unresolved',
      reason:
        evidence.draftStillPresent === false
          ? 'the draft left the Drafts folder without leaving a Sent copy'
          : 'the Drafts folder could not be checked',
    };
  }
  if (ageMs !== undefined && ageMs >= ZOHO_NOT_SENT_MIN_AGE_MS) return { outcome: 'not_sent' };
  return {
    outcome: 'unresolved',
    reason: `Zoho keeps the draft after a send, so an empty Sent folder settles nothing before ${ZOHO_NOT_SENT_MIN_AGE_MS}ms have passed`,
  };
}

/**
 * Rows `reconcileDraftSend` admits: an uncertain send, or a `sending` claim
 * too old to still be in flight because the process that made it died.
 */
export function awaitsReconciliation(
  ctx: DraftServiceContext,
  record: DraftRecord,
  at: Date,
): boolean {
  if (record.status === 'send_unknown') return true;
  if (record.status !== 'sending') return false;
  const claimedAtMs = claimedAtOf(record);
  return claimedAtMs !== undefined && at.getTime() - claimedAtMs >= ctx.staleSendingAfterMs;
}

/** Applies one reconciliation decision; `unresolved` deliberately writes nothing. */
async function settleReconciledSend(
  ctx: DraftServiceContext,
  record: DraftRecord,
  outcome: ReconcileSendOutcome,
  context: { sentCopy?: NormalizedEmail; claimedAtMs: number },
): Promise<DraftRecord> {
  const { store, now } = ctx;
  switch (outcome) {
    case 'sent':
      return store.resolveUnknownSend({
        draftId: record.id,
        outcome: 'sent',
        receipt: {
          ...(context.sentCopy === undefined
            ? {}
            : {
                providerMessageId: context.sentCopy.messageId,
                ...(context.sentCopy.threadId === undefined
                  ? {}
                  : { threadId: context.sentCopy.threadId }),
                ...(context.sentCopy.conversationId === undefined
                  ? {}
                  : { conversationId: context.sentCopy.conversationId }),
                ...(context.sentCopy.internetMessageId === undefined
                  ? {}
                  : { internetMessageId: context.sentCopy.internetMessageId }),
              }),
        },
        at: now(),
      });
    case 'not_sent':
      return store.resolveUnknownSend({
        draftId: record.id,
        outcome: 'not_sent',
        // Nothing else touches a claimed row, so the claim day is the day
        // whose send quota this draft consumed.
        usageDate: usageDateOf(new Date(context.claimedAtMs)),
        at: now(),
      });
    case 'unresolved':
      return record;
  }
}

/**
 * Settles a send whose outcome `sendDraft` could not observe, using the only
 * authority on the question: the mailbox itself.
 *
 * Admissible rows are `send_unknown` and `sending` claims older than
 * `STALE_SENDING_TIMEOUT_FACTOR` provider timeouts (a crashed claim). A row
 * already `sent` answers `sent` idempotently without touching the provider;
 * any other status is INVALID_QUERY.
 *
 * Two facts are gathered, each bounded by the provider timeout and each
 * allowed to come back unknown: whether the provider draft is still in
 * Drafts, and whether the Sent folder holds a copy addressed to the same
 * recipient with the same subject, dated at or after the claim. See
 * `decideReconcileOutcome` for how they settle the row. `sent` finalizes the
 * delivery with a receipt rebuilt from the Sent copy; `not_sent` returns the
 * row to `created` and gives back the send quota of the claim day, making the
 * draft sendable again; `unresolved` leaves the row exactly as it was.
 */
export async function reconcileDraftSend(
  ctx: DraftServiceContext,
  input: ReconcileDraftSendInput,
): Promise<ReconcileDraftSendResult> {
  const { store, correlationId, timeoutMs, now, staleSendingAfterMs } = ctx;
  const record = await store.findDraftById(input.internalDraftId);
  if (record === undefined) {
    throw new GatewayError('DRAFT_NOT_FOUND', `No gateway draft ${input.internalDraftId}`, {
      retryable: false,
      correlationId,
    });
  }
  const unknownEvidence: ReconcileSendEvidence = {
    draftStillPresent: undefined,
    sentMatchFound: undefined,
  };
  if (record.status === 'sent') {
    return {
      ...toDraftSummary(record),
      outcome: 'sent',
      evidence: unknownEvidence,
      reason: 'the send was already settled',
    };
  }
  if (record.status !== 'send_unknown' && record.status !== 'sending') {
    throw invalid(
      `Draft ${record.id} is in status "${record.status}" and is not awaiting reconciliation`,
      correlationId,
    );
  }

  const startedAt = now();
  const claimedAtMs = claimedAtOf(record);
  const ageMs = claimedAtMs === undefined ? undefined : startedAt.getTime() - claimedAtMs;
  if (record.status === 'sending' && !awaitsReconciliation(ctx, record, startedAt)) {
    throw invalid(
      `Draft ${record.id} is still being sent; a "sending" row is only reconcilable ${staleSendingAfterMs}ms after it was claimed`,
      correlationId,
    );
  }

  try {
    const adapter = await adapterForDraft(ctx, record);
    const gaps: string[] = [];

    let draftStillPresent: boolean | undefined;
    let draftSubject: string | undefined;
    if (record.providerDraftId === undefined) {
      gaps.push('the row carries no provider draft id');
    } else {
      try {
        const snapshot = await withProviderTimeout(
          adapter.getDraft(record.providerDraftId),
          timeoutMs,
          record.mailboxId,
          correlationId,
        );
        draftStillPresent = true;
        draftSubject = snapshot.subject;
      } catch (error) {
        const failure = toGatewayFailure(error, correlationId);
        // A 404 is an answer: the draft is no longer in the mailbox.
        if (failure.code === 'DRAFT_NOT_FOUND' || failure.code === 'MESSAGE_NOT_FOUND') {
          draftStillPresent = false;
        } else {
          gaps.push(`the Drafts check failed with ${failure.code}`);
        }
      }
    }

    const reference = await store.findDraftMessageReference(record.id);
    const recipient = record.normalizedRecipientEmail ?? reference?.normalizedRecipient;
    const subject = draftSubject ?? reference?.subject;
    const notBefore = claimedAtMs === undefined ? undefined : claimedAtMs - RECONCILE_CLOCK_SKEW_MS;

    let sentMatchFound: boolean | undefined;
    let sentCopy: NormalizedEmail | undefined;
    if (recipient === undefined || subject === undefined) {
      gaps.push('the gateway kept no recipient and subject to recognise a Sent copy');
    } else if (!supportsSentSearch(adapter)) {
      gaps.push(`mailbox ${record.mailboxId} has no adapter that can search the Sent folder`);
    } else {
      const target = { recipient: normalizeRecipient(recipient), subject, notBefore };
      try {
        const found = await withProviderTimeout(
          adapter.searchEmails({
            folder: 'sent',
            to: target.recipient,
            subject,
            limit: RECONCILE_SEARCH_LIMIT,
            ...(notBefore === undefined ? {} : { after: new Date(notBefore).toISOString() }),
          }),
          timeoutMs,
          record.mailboxId,
          correlationId,
        );
        sentCopy = found.items.find((email) => isSentCopy(email, target));
        sentMatchFound = sentCopy !== undefined;
      } catch (error) {
        gaps.push(`the Sent search failed with ${toGatewayFailure(error, correlationId).code}`);
      }
    }

    const evidence: ReconcileSendEvidence = { draftStillPresent, sentMatchFound };
    const decision = decideReconcileOutcome(record.provider, evidence, ageMs);
    const settled = await settleReconciledSend(ctx, record, decision.outcome, {
      ...(sentCopy === undefined ? {} : { sentCopy }),
      claimedAtMs: claimedAtMs ?? startedAt.getTime(),
    });
    await store.recordDraftOperation({
      draftId: record.id,
      operation: 'reconcile',
      status: decision.outcome === 'unresolved' ? 'failed' : 'succeeded',
      correlationId,
      ...(decision.outcome === 'unresolved' ? { errorCode: 'SEND_STATUS_UNKNOWN' } : {}),
    });
    const reason = [decision.reason, ...gaps].filter((entry) => entry !== undefined).join('; ');
    return {
      ...toDraftSummary(settled),
      outcome: decision.outcome,
      evidence,
      ...(reason === '' ? {} : { reason }),
    };
  } catch (error) {
    const failure = toGatewayFailure(error, correlationId);
    await store.recordDraftOperation({
      draftId: record.id,
      operation: 'reconcile',
      status: 'failed',
      correlationId,
      errorCode: failure.code,
    });
    throw failure;
  }
}
