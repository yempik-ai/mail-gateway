// Pure helpers over recipients and draft records: normalisation, the usage day
// a timestamp counts against, and the shapes rows take in tool results.

import type { ProviderDraftSnapshot } from '@yempik/core';
import type {
  DraftRecord,
  DraftResult,
  DraftRowStatus,
  DraftSummary,
  MessageReferenceRow,
} from './types.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRecipient(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidRecipient(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function usageDateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Statuses that mean "this draft already exists"; no provider call may follow. */
export function isLiveDraft(status: DraftRowStatus): boolean {
  return status === 'creating' || status === 'created' || status === 'updated';
}

export function toDraftSummary(record: DraftRecord): DraftSummary {
  return {
    internalDraftId: record.id,
    mailboxId: record.mailboxId,
    provider: record.provider,
    status: record.status,
    ...(record.providerDraftId === undefined ? {} : { providerDraftId: record.providerDraftId }),
    ...(record.providerMessageId === undefined
      ? {}
      : { providerMessageId: record.providerMessageId }),
    ...(record.providerWebUrl === undefined ? {} : { providerWebUrl: record.providerWebUrl }),
    ...(record.sendingIdentityEmail === undefined
      ? {}
      : { sendingIdentityEmail: record.sendingIdentityEmail }),
    ...(record.providerSentMessageId === undefined
      ? {}
      : { providerSentMessageId: record.providerSentMessageId }),
    ...(record.sentAt === undefined ? {} : { sentAt: record.sentAt }),
    ...(record.campaignId === undefined ? {} : { campaignId: record.campaignId }),
    ...(record.prospectId === undefined ? {} : { prospectId: record.prospectId }),
    ...(record.normalizedRecipientEmail === undefined
      ? {}
      : { recipient: record.normalizedRecipientEmail }),
    ...(record.sequenceStep === undefined ? {} : { sequenceStep: record.sequenceStep }),
    ...(record.sourceMessageId === undefined ? {} : { sourceMessageId: record.sourceMessageId }),
    ...(record.lastErrorCode === undefined ? {} : { lastErrorCode: record.lastErrorCode }),
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
  };
}

export function duplicateResult(
  index: number,
  recipient: string,
  record: DraftRecord,
): DraftResult {
  return {
    index,
    recipient,
    internalDraftId: record.id,
    mailboxId: record.mailboxId,
    provider: record.provider,
    status: 'duplicate',
    duplicatePrevented: true,
    ...(record.providerDraftId === undefined ? {} : { providerDraftId: record.providerDraftId }),
    ...(record.providerMessageId === undefined
      ? {}
      : { providerMessageId: record.providerMessageId }),
    ...(record.providerWebUrl === undefined ? {} : { providerWebUrl: record.providerWebUrl }),
    ...(record.sendingIdentityEmail === undefined
      ? {}
      : { sendingIdentityEmail: record.sendingIdentityEmail }),
  };
}

export function messageReferenceOf(
  snapshot: ProviderDraftSnapshot,
  base: {
    mailboxId: string;
    campaignId?: string | undefined;
    prospectId?: string | undefined;
    normalizedRecipient?: string | undefined;
    subject?: string | undefined;
    contentHash?: string | undefined;
    at: Date;
  },
): MessageReferenceRow {
  return {
    mailboxId: base.mailboxId,
    // Reply matching keys off provider ids: fall back to the draft id
    // when the provider does not expose a separate message id.
    providerMessageId: snapshot.providerMessageId ?? snapshot.providerDraftId,
    messageAt: base.at,
    ...(base.campaignId === undefined ? {} : { campaignId: base.campaignId }),
    ...(base.prospectId === undefined ? {} : { prospectId: base.prospectId }),
    ...(snapshot.threadId === undefined ? {} : { threadId: snapshot.threadId }),
    ...(snapshot.conversationId === undefined ? {} : { conversationId: snapshot.conversationId }),
    ...(snapshot.internetMessageId === undefined
      ? {}
      : { internetMessageId: snapshot.internetMessageId }),
    ...(base.normalizedRecipient === undefined
      ? {}
      : { normalizedRecipient: base.normalizedRecipient }),
    ...(base.subject === undefined ? {} : { subject: base.subject }),
    ...(base.contentHash === undefined ? {} : { contentHash: base.contentHash }),
  };
}
