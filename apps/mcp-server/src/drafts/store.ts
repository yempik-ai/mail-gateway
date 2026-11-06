// The persistence contract of the draft service. `store-postgres.ts` implements
// it on Postgres; the unit tests implement it in memory.

import type { GatewayErrorCode, ProviderSendReceipt } from '@yempik/core';
import type {
  DraftMailboxRecord,
  DraftMessageReferenceRecord,
  DraftOperationRow,
  DraftRecord,
  DraftRowStatus,
  MessageReferenceRow,
  NewDraftRow,
  ProspectAssignmentRecord,
} from './types.js';

export interface FinalizeDraftCreationInput {
  draftId: string;
  mailboxId: string;
  providerDraftId: string;
  providerMessageId?: string | undefined;
  providerWebUrl?: string | undefined;
  sendingIdentityEmail: string;
  /** Outreach drafts consume the mailbox daily quota; reply drafts do not. */
  usageDate?: string | undefined;
  /** Adoption records an existing provider draft and is not new draft activity. */
  recordDraftActivity?: boolean | undefined;
  messageReference?: MessageReferenceRow | undefined;
  at: Date;
}

export interface DraftProviderIdentifiers {
  providerDraftId?: string | undefined;
  providerMessageId?: string | undefined;
  providerWebUrl?: string | undefined;
  sendingIdentityEmail?: string | undefined;
}

export type DraftSendClaim =
  | {
      status: 'claimed';
      draft: DraftRecord;
      previousStatus: Extract<DraftRowStatus, 'created' | 'updated'>;
    }
  | { status: 'daily_limit' }
  | { status: 'not_claimable'; draft?: DraftRecord };

export interface ReleaseDraftSendInput {
  draftId: string;
  usageDate: string;
  previousStatus: Extract<DraftRowStatus, 'created' | 'updated'>;
  errorCode: GatewayErrorCode;
  uncertain: boolean;
  at: Date;
}

/**
 * Settles a row left in `sending`/`send_unknown` once provider evidence says
 * what happened. `sent` finalizes the delivery with the receipt reconstructed
 * from the Sent copy; `not_sent` returns the row to `created` and gives back
 * the send quota it consumed on `usageDate` (the day of the claim), keeping
 * `lastErrorCode` as the record of why the send became uncertain.
 */
export type ResolveUnknownSendInput =
  | { draftId: string; outcome: 'sent'; receipt: ProviderSendReceipt; at: Date }
  | { draftId: string; outcome: 'not_sent'; usageDate: string; at: Date };

/**
 * The only persistence the draft service needs. Fakes of this interface drive
 * every routing/idempotency/limit test.
 */
export interface DraftStore {
  listMailboxes(): Promise<DraftMailboxRecord[]>;
  ensureCampaign(campaignId: string): Promise<void>;
  listProspectAssignments(campaignId: string): Promise<ProspectAssignmentRecord[]>;
  saveProspectAssignment(assignment: ProspectAssignmentRecord): Promise<void>;
  /** Drafts created per mailbox on `usageDate`, keyed by mailbox id. */
  dailyUsage(usageDate: string): Promise<Record<string, number>>;
  findDraftByIdempotencyKey(idempotencyKey: string): Promise<DraftRecord | undefined>;
  findDraftById(internalDraftId: string): Promise<DraftRecord | undefined>;
  findDraftByProviderDraftId(
    mailboxId: string,
    providerDraftId: string,
  ): Promise<DraftRecord | undefined>;
  listCampaignDrafts(campaignId: string, status?: DraftRowStatus): Promise<DraftRecord[]>;
  /** Inserts a row in status `creating`; `undefined` means a unique constraint lost the race. */
  insertCreatingDraft(row: NewDraftRow): Promise<DraftRecord | undefined>;
  /** Re-arms a `failed`/`deleted` row for another attempt; `undefined` if it moved on. */
  reclaimDraft(internalDraftId: string): Promise<DraftRecord | undefined>;
  /** Atomic success path: provider ids + daily usage + message reference. */
  finalizeDraftCreation(input: FinalizeDraftCreationInput): Promise<DraftRecord>;
  markDraftFailed(internalDraftId: string, errorCode: GatewayErrorCode): Promise<void>;
  markDraftUpdated(
    internalDraftId: string,
    identifiers: DraftProviderIdentifiers,
  ): Promise<DraftRecord>;
  markDraftDeleted(internalDraftId: string): Promise<DraftRecord>;
  claimDraftForSending(
    internalDraftId: string,
    usageDate: string,
    at: Date,
  ): Promise<DraftSendClaim>;
  finalizeDraftSend(
    internalDraftId: string,
    receipt: ProviderSendReceipt,
    at: Date,
  ): Promise<DraftRecord>;
  releaseDraftSend(input: ReleaseDraftSendInput): Promise<DraftRecord>;
  /** Guarded on `sending`/`send_unknown`; settles a claim no send path owns any more. */
  resolveUnknownSend(input: ResolveUnknownSendInput): Promise<DraftRecord>;
  /** `undefined` when the draft never produced a message reference. */
  findDraftMessageReference(
    internalDraftId: string,
  ): Promise<DraftMessageReferenceRecord | undefined>;
  recordDraftOperation(row: DraftOperationRow): Promise<void>;
}
