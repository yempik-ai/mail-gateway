// Postgres implementation of `DraftStore` (drizzle). Every multi-row change runs
// in one transaction; row locks on `drafts` and `daily_mailbox_usage` are the
// concurrency guards for claims and quota.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  campaigns,
  dailyMailboxUsage,
  draftOperations,
  drafts,
  mailboxes,
  messageReferences,
  oauthConnections,
  prospectMailboxAssignments,
  type Database,
} from '@yempik/database';
import { GatewayError } from '@yempik/core';
import type { DraftSendClaim, DraftStore } from './store.js';
import type { DraftRecord } from './types.js';
import {
  applySentReceipt,
  releaseSendUsage,
  toDraftRecord,
  type DraftTableRow,
} from './store-postgres-rows.js';

export function createDatabaseDraftStore(database: Database, correlationId: string): DraftStore {
  const databaseError = (error: unknown, message: string): GatewayError =>
    new GatewayError('DATABASE_ERROR', message, { retryable: true, correlationId, cause: error });

  const requireTableRow = (rows: DraftTableRow[], internalDraftId: string): DraftTableRow => {
    const row = rows[0];
    if (row === undefined) {
      throw new GatewayError('DRAFT_NOT_FOUND', `Draft ${internalDraftId} disappeared`, {
        retryable: false,
        correlationId,
      });
    }
    return row;
  };

  const requireRow = (rows: DraftTableRow[], internalDraftId: string): DraftRecord =>
    toDraftRecord(requireTableRow(rows, internalDraftId));

  return {
    async listMailboxes() {
      try {
        return await database
          .select({
            id: mailboxes.id,
            provider: mailboxes.provider,
            emailAddress: mailboxes.emailAddress,
            aliases: mailboxes.aliases,
            enabled: mailboxes.enabled,
            connectionStatus: mailboxes.connectionStatus,
            // Scalar subquery: oauth_connections carries no uniqueness on
            // (mailbox_id, provider), and a join would multiply mailbox rows.
            // The outer columns are qualified through the table object: in a
            // select field drizzle renders `${mailboxes.id}` as a bare "id",
            // which inside the subquery binds to oauth_connections.id.
            grantedScopes: sql<string[]>`coalesce((
              SELECT c.scopes
              FROM ${oauthConnections} c
              WHERE c.mailbox_id = ${mailboxes}.id AND c.provider = ${mailboxes}.provider
              ORDER BY c.updated_at DESC
              LIMIT 1
            ), ARRAY[]::text[])`,
            perRunDraftLimit: mailboxes.perRunDraftLimit,
            dailyDraftLimit: mailboxes.dailyDraftLimit,
            dailySendLimit: mailboxes.dailySendLimit,
            dailySendLimitsByIdentity: mailboxes.dailySendLimitsByIdentity,
            routingPriority: mailboxes.routingPriority,
          })
          .from(mailboxes)
          .orderBy(asc(mailboxes.routingPriority), asc(mailboxes.id));
      } catch (error) {
        throw databaseError(error, 'The mailbox registry is unavailable');
      }
    },

    async ensureCampaign(campaignId) {
      try {
        await database
          .insert(campaigns)
          .values({ id: campaignId, name: campaignId })
          .onConflictDoNothing();
      } catch (error) {
        throw databaseError(error, 'The campaign registry is unavailable');
      }
    },

    async listProspectAssignments(campaignId) {
      try {
        return await database
          .select({
            campaignId: prospectMailboxAssignments.campaignId,
            prospectId: prospectMailboxAssignments.prospectId,
            normalizedRecipientEmail: prospectMailboxAssignments.normalizedRecipientEmail,
            mailboxId: prospectMailboxAssignments.mailboxId,
          })
          .from(prospectMailboxAssignments)
          .where(eq(prospectMailboxAssignments.campaignId, campaignId));
      } catch (error) {
        throw databaseError(error, 'The prospect assignment registry is unavailable');
      }
    },

    async saveProspectAssignment(assignment) {
      try {
        // An existing assignment always wins: a prospect is never moved.
        await database.insert(prospectMailboxAssignments).values(assignment).onConflictDoNothing();
      } catch (error) {
        throw databaseError(error, 'The prospect assignment could not be stored');
      }
    },

    async dailyUsage(usageDate) {
      try {
        const rows = await database
          .select({
            mailboxId: dailyMailboxUsage.mailboxId,
            draftsCreated: dailyMailboxUsage.draftsCreated,
          })
          .from(dailyMailboxUsage)
          .where(eq(dailyMailboxUsage.usageDate, usageDate));
        return Object.fromEntries(rows.map((row) => [row.mailboxId, row.draftsCreated]));
      } catch (error) {
        throw databaseError(error, 'The daily usage counters are unavailable');
      }
    },

    async findDraftByIdempotencyKey(idempotencyKey) {
      try {
        const rows = await database
          .select()
          .from(drafts)
          .where(eq(drafts.idempotencyKey, idempotencyKey))
          .limit(1);
        const row = rows[0];
        return row === undefined ? undefined : toDraftRecord(row);
      } catch (error) {
        throw databaseError(error, 'The draft registry is unavailable');
      }
    },

    async findDraftById(internalDraftId) {
      try {
        const rows = await database
          .select()
          .from(drafts)
          .where(eq(drafts.id, internalDraftId))
          .limit(1);
        const row = rows[0];
        return row === undefined ? undefined : toDraftRecord(row);
      } catch (error) {
        throw databaseError(error, 'The draft registry is unavailable');
      }
    },

    async findDraftByProviderDraftId(mailboxId, providerDraftId) {
      try {
        const rows = await database
          .select()
          .from(drafts)
          .where(and(eq(drafts.mailboxId, mailboxId), eq(drafts.providerDraftId, providerDraftId)))
          .limit(1);
        const row = rows[0];
        return row === undefined ? undefined : toDraftRecord(row);
      } catch (error) {
        throw databaseError(error, 'The draft registry is unavailable');
      }
    },

    async listCampaignDrafts(campaignId, status) {
      try {
        const filter =
          status === undefined
            ? eq(drafts.campaignId, campaignId)
            : and(eq(drafts.campaignId, campaignId), eq(drafts.status, status));
        const rows = await database
          .select()
          .from(drafts)
          .where(filter)
          .orderBy(asc(drafts.sequenceStep), asc(drafts.createdAt));
        return rows.map(toDraftRecord);
      } catch (error) {
        throw databaseError(error, 'The draft registry is unavailable');
      }
    },

    async insertCreatingDraft(row) {
      try {
        // `onConflictDoNothing` covers both unique constraints on drafts: an
        // empty result means a concurrent call already claimed the slot.
        const inserted = await database
          .insert(drafts)
          .values({ ...row, status: 'creating' })
          .onConflictDoNothing()
          .returning();
        const created = inserted[0];
        return created === undefined ? undefined : toDraftRecord(created);
      } catch (error) {
        throw databaseError(error, 'The draft row could not be created');
      }
    },

    async reclaimDraft(internalDraftId) {
      try {
        const rows = await database
          .update(drafts)
          .set({ status: 'creating', lastErrorCode: null, updatedAt: new Date() })
          .where(and(eq(drafts.id, internalDraftId), inArray(drafts.status, ['failed', 'deleted'])))
          .returning();
        const row = rows[0];
        return row === undefined ? undefined : toDraftRecord(row);
      } catch (error) {
        throw databaseError(error, 'The draft row could not be reclaimed');
      }
    },

    async finalizeDraftCreation(input) {
      try {
        return await database.transaction(async (tx) => {
          const updated = await tx
            .update(drafts)
            .set({
              status: 'created',
              providerDraftId: input.providerDraftId,
              providerMessageId: input.providerMessageId ?? null,
              providerWebUrl: input.providerWebUrl ?? null,
              sendingIdentityEmail: input.sendingIdentityEmail,
              lastErrorCode: null,
              updatedAt: input.at,
            })
            .where(eq(drafts.id, input.draftId))
            .returning();

          if (input.usageDate !== undefined) {
            await tx
              .insert(dailyMailboxUsage)
              .values({
                mailboxId: input.mailboxId,
                usageDate: input.usageDate,
                draftsCreated: 1,
                updatedAt: input.at,
              })
              .onConflictDoUpdate({
                target: [dailyMailboxUsage.mailboxId, dailyMailboxUsage.usageDate],
                set: {
                  draftsCreated: sql`${dailyMailboxUsage.draftsCreated} + 1`,
                  updatedAt: input.at,
                },
              });
          }

          if (input.messageReference !== undefined) {
            await tx
              .insert(messageReferences)
              .values({ ...input.messageReference, draftId: input.draftId });
          }

          if (input.recordDraftActivity !== false) {
            await tx
              .update(mailboxes)
              .set({ lastSuccessfulDraftAt: input.at })
              .where(eq(mailboxes.id, input.mailboxId));
          }

          return requireRow(updated, input.draftId);
        });
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw databaseError(error, 'The draft could not be finalized');
      }
    },

    async markDraftFailed(internalDraftId, errorCode) {
      try {
        await database
          .update(drafts)
          .set({ status: 'failed', lastErrorCode: errorCode, updatedAt: new Date() })
          .where(eq(drafts.id, internalDraftId));
      } catch (error) {
        throw databaseError(error, 'The draft failure could not be recorded');
      }
    },

    async markDraftUpdated(internalDraftId, identifiers) {
      try {
        const rows = await database
          .update(drafts)
          .set({
            status: 'updated',
            updatedAt: new Date(),
            ...(identifiers.providerDraftId === undefined
              ? {}
              : { providerDraftId: identifiers.providerDraftId }),
            ...(identifiers.providerMessageId === undefined
              ? {}
              : { providerMessageId: identifiers.providerMessageId }),
            ...(identifiers.providerWebUrl === undefined
              ? {}
              : { providerWebUrl: identifiers.providerWebUrl }),
            ...(identifiers.sendingIdentityEmail === undefined
              ? {}
              : { sendingIdentityEmail: identifiers.sendingIdentityEmail }),
          })
          .where(eq(drafts.id, internalDraftId))
          .returning();
        return requireRow(rows, internalDraftId);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw databaseError(error, 'The draft update could not be recorded');
      }
    },

    async markDraftDeleted(internalDraftId) {
      try {
        const rows = await database
          .update(drafts)
          .set({ status: 'deleted', updatedAt: new Date() })
          .where(eq(drafts.id, internalDraftId))
          .returning();
        return requireRow(rows, internalDraftId);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw databaseError(error, 'The draft deletion could not be recorded');
      }
    },

    async claimDraftForSending(internalDraftId, usageDate, at) {
      try {
        return await database.transaction(async (tx): Promise<DraftSendClaim> => {
          const locked = await tx
            .select()
            .from(drafts)
            .where(eq(drafts.id, internalDraftId))
            .limit(1)
            .for('update');
          const row = locked[0];
          if (row === undefined) return { status: 'not_claimable' };
          if (row.status !== 'created' && row.status !== 'updated') {
            return { status: 'not_claimable', draft: toDraftRecord(row) };
          }
          const previousStatus = row.status;

          await tx
            .insert(dailyMailboxUsage)
            .values({
              mailboxId: row.mailboxId,
              usageDate,
              draftsCreated: 0,
              messagesSent: 0,
              messagesSentByIdentity: {},
              updatedAt: at,
            })
            .onConflictDoNothing();
          // Keep statements sequential on the transaction connection. The
          // usage-row lock serializes concurrent sends from the same mailbox.
          const usage = await tx
            .select({
              messagesSent: dailyMailboxUsage.messagesSent,
              messagesSentByIdentity: dailyMailboxUsage.messagesSentByIdentity,
            })
            .from(dailyMailboxUsage)
            .where(
              and(
                eq(dailyMailboxUsage.mailboxId, row.mailboxId),
                eq(dailyMailboxUsage.usageDate, usageDate),
              ),
            )
            .limit(1)
            .for('update');
          const mailbox = await tx
            .select({
              dailySendLimit: mailboxes.dailySendLimit,
              dailySendLimitsByIdentity: mailboxes.dailySendLimitsByIdentity,
            })
            .from(mailboxes)
            .where(eq(mailboxes.id, row.mailboxId))
            .limit(1);
          const usageRow = usage[0];
          const mailboxRow = mailbox[0];
          if (usageRow === undefined || mailboxRow === undefined) {
            return { status: 'daily_limit' };
          }
          const identity = row.sendingIdentityEmail.trim().toLowerCase();
          const configuredIdentityLimit = mailboxRow.dailySendLimitsByIdentity[identity];
          const identityLimit =
            typeof configuredIdentityLimit === 'number' &&
            Number.isInteger(configuredIdentityLimit) &&
            configuredIdentityLimit >= 0
              ? configuredIdentityLimit
              : mailboxRow.dailySendLimit;
          const identityUsage = usageRow.messagesSentByIdentity[identity] ?? 0;
          if (
            usageRow.messagesSent >= mailboxRow.dailySendLimit ||
            identityUsage >= identityLimit
          ) {
            return { status: 'daily_limit' };
          }

          await tx
            .update(dailyMailboxUsage)
            .set({
              messagesSent: sql`${dailyMailboxUsage.messagesSent} + 1`,
              messagesSentByIdentity: {
                ...usageRow.messagesSentByIdentity,
                [identity]: identityUsage + 1,
              },
              updatedAt: at,
            })
            .where(
              and(
                eq(dailyMailboxUsage.mailboxId, row.mailboxId),
                eq(dailyMailboxUsage.usageDate, usageDate),
              ),
            );
          const claimed = await tx
            .update(drafts)
            .set({ status: 'sending', lastErrorCode: null, updatedAt: at })
            .where(eq(drafts.id, internalDraftId))
            .returning();
          return {
            status: 'claimed',
            draft: requireRow(claimed, internalDraftId),
            previousStatus,
          };
        });
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw databaseError(error, 'The draft could not be claimed for sending');
      }
    },

    async finalizeDraftSend(internalDraftId, receipt, at) {
      try {
        return await database.transaction(async (tx) => {
          const rows = await tx
            .update(drafts)
            .set({
              status: 'sent',
              providerSentMessageId: receipt.providerMessageId ?? null,
              providerWebUrl: null,
              sentAt: at,
              lastErrorCode: null,
              updatedAt: at,
            })
            .where(and(eq(drafts.id, internalDraftId), eq(drafts.status, 'sending')))
            .returning();
          const sent = requireTableRow(rows, internalDraftId);
          await applySentReceipt(tx, sent, receipt, at);
          return toDraftRecord(sent);
        });
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw databaseError(error, 'The accepted send could not be finalized');
      }
    },

    async releaseDraftSend(input) {
      try {
        return await database.transaction(async (tx) => {
          const rows = await tx
            .update(drafts)
            .set({
              status: input.uncertain ? 'send_unknown' : input.previousStatus,
              lastErrorCode: input.errorCode,
              updatedAt: input.at,
            })
            .where(and(eq(drafts.id, input.draftId), eq(drafts.status, 'sending')))
            .returning();
          const released = rows[0];
          if (released === undefined) {
            const current = await tx
              .select()
              .from(drafts)
              .where(eq(drafts.id, input.draftId))
              .limit(1);
            return requireRow(current, input.draftId);
          }
          if (!input.uncertain) {
            await releaseSendUsage(tx, {
              mailboxId: released.mailboxId,
              sendingIdentityEmail: released.sendingIdentityEmail,
              usageDate: input.usageDate,
              at: input.at,
            });
          }
          return toDraftRecord(released);
        });
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw databaseError(error, 'The send failure could not be recorded');
      }
    },

    async resolveUnknownSend(input) {
      // The guard is the concurrency lock: only a row no send path owns any
      // more can be settled from the outside.
      const unsettled = inArray(drafts.status, ['sending', 'send_unknown']);
      const requireUnsettledRow = (rows: DraftTableRow[]): DraftTableRow => {
        const row = rows[0];
        if (row === undefined) {
          throw new GatewayError(
            'DRAFT_NOT_FOUND',
            `Draft ${input.draftId} is no longer awaiting reconciliation`,
            { retryable: false, correlationId },
          );
        }
        return row;
      };
      try {
        return await database.transaction(async (tx) => {
          if (input.outcome === 'sent') {
            const rows = await tx
              .update(drafts)
              .set({
                status: 'sent',
                providerSentMessageId: input.receipt.providerMessageId ?? null,
                providerWebUrl: null,
                sentAt: input.at,
                lastErrorCode: null,
                updatedAt: input.at,
              })
              .where(and(eq(drafts.id, input.draftId), unsettled))
              .returning();
            const sent = requireUnsettledRow(rows);
            await applySentReceipt(tx, sent, input.receipt, input.at);
            return toDraftRecord(sent);
          }

          // `lastErrorCode` stays: it is the record of why the send became
          // uncertain in the first place.
          const rows = await tx
            .update(drafts)
            .set({ status: 'created', updatedAt: input.at })
            .where(and(eq(drafts.id, input.draftId), unsettled))
            .returning();
          const released = requireUnsettledRow(rows);
          await releaseSendUsage(tx, {
            mailboxId: released.mailboxId,
            sendingIdentityEmail: released.sendingIdentityEmail,
            usageDate: input.usageDate,
            at: input.at,
          });
          return toDraftRecord(released);
        });
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw databaseError(error, 'The uncertain send could not be resolved');
      }
    },

    async findDraftMessageReference(internalDraftId) {
      try {
        const rows = await database
          .select({
            normalizedRecipient: messageReferences.normalizedRecipient,
            subject: messageReferences.subject,
          })
          .from(messageReferences)
          .where(eq(messageReferences.draftId, internalDraftId))
          .limit(1);
        const row = rows[0];
        if (row === undefined) return undefined;
        return {
          ...(row.normalizedRecipient === null
            ? {}
            : { normalizedRecipient: row.normalizedRecipient }),
          ...(row.subject === null ? {} : { subject: row.subject }),
        };
      } catch (error) {
        throw databaseError(error, 'The draft message reference could not be read');
      }
    },

    async recordDraftOperation(row) {
      // Bookkeeping must never mask the operation it describes.
      await database
        .insert(draftOperations)
        .values({
          draftId: row.draftId,
          operation: row.operation,
          status: row.status,
          correlationId,
          ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
        })
        .catch(() => undefined);
    },
  };
}
