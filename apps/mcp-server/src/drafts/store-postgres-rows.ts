// Row mapping and the transaction fragments shared by several
// `createDatabaseDraftStore` methods.

import { and, eq, sql } from 'drizzle-orm';
import {
  dailyMailboxUsage,
  mailboxes,
  messageReferences,
  type Database,
  type drafts,
} from '@yempik/database';
import type { ProviderSendReceipt } from '@yempik/core';
import type { DraftRecord } from './types.js';

export type DraftTableRow = typeof drafts.$inferSelect;

/** The handle drizzle hands to a `database.transaction` callback. */
export type DraftTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function isoOrUndefined(value: Date | null): string | undefined {
  return value === null ? undefined : value.toISOString();
}

function nullToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export function toDraftRecord(row: DraftTableRow): DraftRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    mailboxId: row.mailboxId,
    provider: row.provider,
    status: row.status,
    providerDraftId: nullToUndefined(row.providerDraftId),
    providerMessageId: nullToUndefined(row.providerMessageId),
    providerWebUrl: nullToUndefined(row.providerWebUrl),
    sendingIdentityEmail: row.sendingIdentityEmail,
    providerSentMessageId: nullToUndefined(row.providerSentMessageId),
    sentAt: isoOrUndefined(row.sentAt),
    campaignId: nullToUndefined(row.campaignId),
    prospectId: nullToUndefined(row.prospectId),
    normalizedRecipientEmail: nullToUndefined(row.normalizedRecipientEmail),
    sequenceStep: nullToUndefined(row.sequenceStep),
    sourceMessageId: nullToUndefined(row.sourceMessageId),
    contentHash: nullToUndefined(row.contentHash),
    lastErrorCode: nullToUndefined(row.lastErrorCode),
    createdAt: isoOrUndefined(row.createdAt),
    updatedAt: isoOrUndefined(row.updatedAt),
  };
}

/** Records a delivery against a row already moved to `sent`: reference ids and mailbox liveness. */
export async function applySentReceipt(
  tx: DraftTransaction,
  row: DraftTableRow,
  receipt: ProviderSendReceipt,
  at: Date,
): Promise<void> {
  await tx
    .update(messageReferences)
    .set({
      ...(receipt.providerMessageId === undefined
        ? {}
        : { providerMessageId: receipt.providerMessageId }),
      ...(receipt.threadId === undefined ? {} : { threadId: receipt.threadId }),
      ...(receipt.conversationId === undefined ? {} : { conversationId: receipt.conversationId }),
      // An omitted value is not proof that a provider retained the draft's
      // RFC Message-ID (Zoho creates a new sent item).
      internetMessageId: receipt.internetMessageId ?? null,
      messageAt: at,
    })
    .where(eq(messageReferences.draftId, row.id));
  await tx
    .update(mailboxes)
    .set({ lastSuccessfulSendAt: at, updatedAt: at })
    .where(eq(mailboxes.id, row.mailboxId));
}

/** Gives back the one send this row consumed on `usageDate`, aggregate and per identity. */
export async function releaseSendUsage(
  tx: DraftTransaction,
  input: { mailboxId: string; sendingIdentityEmail: string; usageDate: string; at: Date },
): Promise<void> {
  const scope = and(
    eq(dailyMailboxUsage.mailboxId, input.mailboxId),
    eq(dailyMailboxUsage.usageDate, input.usageDate),
  );
  const usage = await tx
    .select({ messagesSentByIdentity: dailyMailboxUsage.messagesSentByIdentity })
    .from(dailyMailboxUsage)
    .where(scope)
    .limit(1)
    .for('update');
  const identity = input.sendingIdentityEmail.trim().toLowerCase();
  const byIdentity = usage[0]?.messagesSentByIdentity ?? {};
  await tx
    .update(dailyMailboxUsage)
    .set({
      messagesSent: sql`greatest(${dailyMailboxUsage.messagesSent} - 1, 0)`,
      messagesSentByIdentity: {
        ...byIdentity,
        [identity]: Math.max((byIdentity[identity] ?? 0) - 1, 0),
      },
      updatedAt: input.at,
    })
    .where(scope);
}
