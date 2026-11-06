// Editing a gateway-owned draft in place: headers, sending identity and body.

import { GatewayError } from '@yempik/core';
import {
  bodyProblem,
  composeBody,
  currentIdentityOf,
  providedBodyFields,
  requireSendingIdentity,
  senderOnly,
} from './compose.js';
import type { DraftServiceContext } from './context.js';
import { invalid, toGatewayFailure, withProviderTimeout } from './errors.js';
import { requireAdapter, requireGatewayDraft, requireUsableMailbox } from './mailbox.js';
import { isValidRecipient, toDraftSummary } from './records.js';
import type { UpdateOutreachDraftInput, UpdateOutreachDraftResult } from './types.js';

export async function updateOutreachDraft(
  ctx: DraftServiceContext,
  input: UpdateOutreachDraftInput,
): Promise<UpdateOutreachDraftResult> {
  const { store, correlationId, quoteTimeZone, timeoutMs } = ctx;
  const replacesBody = providedBodyFields(input).length > 0;
  if (
    input.subject === undefined &&
    input.to === undefined &&
    input.fromAddress === undefined &&
    !replacesBody
  ) {
    throw invalid(
      'An update needs at least one of subject, to, fromAddress, body, textBody, htmlBody',
      correlationId,
    );
  }
  const problem = replacesBody ? bodyProblem(input) : undefined;
  if (problem !== undefined) throw invalid(problem, correlationId);
  if (input.to !== undefined && !isValidRecipient(input.to)) {
    throw new GatewayError('INVALID_RECIPIENT', `"${input.to}" is not a valid email address`, {
      retryable: false,
      correlationId,
    });
  }

  const record = await requireGatewayDraft(ctx, input.internalDraftId);
  const providerDraftId = record.providerDraftId ?? '';
  try {
    const mailbox = requireUsableMailbox(
      await store.listMailboxes(),
      record.mailboxId,
      correlationId,
    );
    const fromAddress = requireSendingIdentity(mailbox, input.fromAddress, correlationId);
    const adapter = requireAdapter(ctx, mailbox);
    const sender = replacesBody
      ? await composeBody(
          ctx,
          mailbox,
          fromAddress,
          input,
          input.includeSignature ?? true,
          // Only consulted without fromAddress: an explicit identity
          // replaces the stored one, stale or not.
          fromAddress === undefined ? currentIdentityOf(mailbox, record, correlationId) : undefined,
        )
      : await senderOnly(ctx, mailbox, fromAddress);
    // A reply keeps its conversation history: the adapter quotes the
    // original again below the new body instead of dropping it.
    const quote =
      replacesBody && record.sourceMessageId !== undefined
        ? {
            quoteOriginalMessageId: record.sourceMessageId,
            ...(quoteTimeZone === undefined ? {} : { quoteTimeZone }),
          }
        : {};
    const snapshot = await withProviderTimeout(
      adapter.updateDraft(providerDraftId, {
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.to === undefined ? {} : { to: [input.to.trim()] }),
        ...(sender.from === undefined ? {} : { from: sender.from }),
        ...(sender.fromDisplayName === undefined
          ? {}
          : { fromDisplayName: sender.fromDisplayName }),
        ...(sender.textBody === undefined ? {} : { textBody: sender.textBody }),
        ...(sender.htmlBody === undefined ? {} : { htmlBody: sender.htmlBody }),
        ...quote,
      }),
      timeoutMs,
      record.mailboxId,
      correlationId,
    );
    // The dedup identity (campaign, recipient, step) is intentionally left
    // untouched: rewriting it would move the row under its unique index.
    const updated = await store.markDraftUpdated(record.id, {
      providerDraftId: snapshot.providerDraftId,
      ...(fromAddress === undefined ? {} : { sendingIdentityEmail: fromAddress }),
      ...(snapshot.providerMessageId === undefined
        ? {}
        : { providerMessageId: snapshot.providerMessageId }),
      ...(snapshot.providerWebUrl === undefined ? {} : { providerWebUrl: snapshot.providerWebUrl }),
    });
    await store.recordDraftOperation({
      draftId: record.id,
      operation: 'update',
      status: 'succeeded',
      correlationId,
    });
    const summary = toDraftSummary(updated);
    return snapshot.quoteRebuilt === true ? { ...summary, quoteRebuilt: true } : summary;
  } catch (error) {
    const gatewayError = toGatewayFailure(error, correlationId);
    await store.recordDraftOperation({
      draftId: record.id,
      operation: 'update',
      status: 'failed',
      correlationId,
      errorCode: gatewayError.code,
    });
    throw gatewayError;
  }
}
