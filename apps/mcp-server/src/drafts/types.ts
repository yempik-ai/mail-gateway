// Records, inputs and results of the draft service. Nothing here has behaviour;
// the store contract that moves these records lives in `store.ts`.

import type {
  GatewayErrorCode,
  MailDraftAdapter,
  MailboxConnectionStatus,
  MailboxProvider,
} from '@yempik/core';
import type { AdapterMailboxContext } from '../mail-search.js';

/**
 * Seam between the draft tools and the provider draft adapters, mirroring
 * `AdapterFactory` on the read side. The concrete factory is wired by the
 * composition root; `undefined` means "no draft adapter for this mailbox yet"
 * and surfaces as UNSUPPORTED_OPERATION.
 */
export type DraftAdapterFactory = (
  mailbox: AdapterMailboxContext,
  correlationId: string,
) => MailDraftAdapter | undefined;

export type DraftRowStatus =
  'creating' | 'created' | 'updated' | 'sending' | 'sent' | 'send_unknown' | 'deleted' | 'failed';
export type DraftOutcomeStatus = 'created' | 'duplicate' | 'failed';
export type RoutingMode = 'explicit' | 'distributed';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface DraftMailboxRecord extends AdapterMailboxContext {
  enabled: boolean;
  connectionStatus: MailboxConnectionStatus;
  /** Scopes the stored OAuth grant carries, frozen at consent time. */
  grantedScopes: string[];
  perRunDraftLimit: number;
  dailyDraftLimit: number;
  dailySendLimit: number;
  dailySendLimitsByIdentity: Record<string, number>;
  routingPriority: number;
}

export interface DraftRecord {
  id: string;
  idempotencyKey: string;
  mailboxId: string;
  provider: MailboxProvider;
  status: DraftRowStatus;
  providerDraftId?: string | undefined;
  providerMessageId?: string | undefined;
  providerWebUrl?: string | undefined;
  sendingIdentityEmail?: string | undefined;
  providerSentMessageId?: string | undefined;
  sentAt?: string | undefined;
  campaignId?: string | undefined;
  prospectId?: string | undefined;
  normalizedRecipientEmail?: string | undefined;
  sequenceStep?: number | undefined;
  sourceMessageId?: string | undefined;
  contentHash?: string | undefined;
  lastErrorCode?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface NewDraftRow {
  idempotencyKey: string;
  mailboxId: string;
  provider: MailboxProvider;
  sendingIdentityEmail: string;
  campaignId?: string | undefined;
  prospectId?: string | undefined;
  normalizedRecipientEmail?: string | undefined;
  sequenceStep?: number | undefined;
  sourceMessageId?: string | undefined;
  contentHash?: string | undefined;
}

export interface ProspectAssignmentRecord {
  campaignId: string;
  prospectId: string;
  normalizedRecipientEmail: string;
  mailboxId: string;
}

export interface MessageReferenceRow {
  mailboxId: string;
  campaignId?: string | undefined;
  prospectId?: string | undefined;
  providerMessageId: string;
  threadId?: string | undefined;
  conversationId?: string | undefined;
  internetMessageId?: string | undefined;
  normalizedRecipient?: string | undefined;
  subject?: string | undefined;
  contentHash?: string | undefined;
  messageAt: Date;
}

export interface DraftOperationRow {
  draftId: string;
  operation: 'create' | 'reply_create' | 'adopt' | 'update' | 'send' | 'delete' | 'reconcile';
  status: 'succeeded' | 'failed';
  correlationId: string;
  errorCode?: string | undefined;
}

/**
 * Recipient and subject as the gateway recorded them when the draft was
 * created. They outlive the provider draft, which Gmail and Microsoft consume
 * on send, and are the only way to recognise a Sent copy afterwards.
 */
export interface DraftMessageReferenceRecord {
  normalizedRecipient?: string | undefined;
  subject?: string | undefined;
}

// ---------------------------------------------------------------------------
// Inputs and results
// ---------------------------------------------------------------------------

/**
 * The three ways a caller can author a body. Exactly one is accepted per draft:
 * the gateway renders it to a text part plus an HTML part itself.
 */
export interface DraftBodyInput {
  /** Markdown, the preferred form for LLM-authored bodies. */
  body?: string | undefined;
  textBody?: string | undefined;
  htmlBody?: string | undefined;
}

export interface OutreachDraftInput extends DraftBodyInput {
  prospectId?: string | undefined;
  to: string;
  subject: string;
}

export interface CreateOutreachDraftsInput {
  campaignId: string;
  routingMode: RoutingMode;
  mailboxId?: string | undefined;
  fromAddress?: string | undefined;
  sequenceStep?: number | undefined;
  /** Append the stored signature of the sending identity to every draft (default true). */
  includeSignature?: boolean | undefined;
  drafts: OutreachDraftInput[];
}

export interface CreateReplyDraftInput extends DraftBodyInput {
  mailboxId: string;
  sourceMessageId: string;
  replyMode: 'reply' | 'replyAll';
  fromAddress?: string | undefined;
  /** Append the stored signature of the sending identity (default true). */
  includeSignature?: boolean | undefined;
  campaignId?: string | undefined;
  prospectId?: string | undefined;
}

export interface UpdateOutreachDraftInput extends DraftBodyInput {
  internalDraftId: string;
  subject?: string | undefined;
  to?: string | undefined;
  fromAddress?: string | undefined;
  /** Append the stored signature when the body is replaced (default true). */
  includeSignature?: boolean | undefined;
}

export interface DeleteOutreachDraftInput {
  internalDraftId: string;
}

export interface DeleteOutreachDraftsInput {
  internalDraftIds: string[];
}

export interface AdoptExternalDraftsInput {
  mailboxId: string;
  providerMessageIds: string[];
  campaignId?: string | undefined;
}

export interface ListCampaignDraftsInput {
  campaignId: string;
  status?: DraftRowStatus | undefined;
}

export interface GetDraftStatusInput {
  internalDraftId: string;
}

export interface SendDraftInput {
  internalDraftId: string;
}

export interface UpdateOutreachDraftResult extends DraftSummary {
  /**
   * Present (true) only when the provider could not keep the reply's original
   * quote and the gateway rebuilt it from the source message, so the older
   * conversation history and the provider's quote layout are gone.
   */
  quoteRebuilt?: true | undefined;
}

export interface SendDraftResult extends DraftSummary {
  status: 'sent';
  alreadySent: boolean;
  acceptedAt?: string | undefined;
}

export interface ReconcileDraftSendInput {
  internalDraftId: string;
}

/** What the provider evidence settled the uncertain send to. */
export type ReconcileSendOutcome = 'sent' | 'not_sent' | 'unresolved';

/** Each fact is `undefined` when the provider could not answer for it. */
export interface ReconcileSendEvidence {
  draftStillPresent: boolean | undefined;
  sentMatchFound: boolean | undefined;
}

export interface ReconcileDraftSendResult extends DraftSummary {
  outcome: ReconcileSendOutcome;
  evidence: ReconcileSendEvidence;
  /** Why the evidence was incomplete or what settled it; absent when nothing needs explaining. */
  reason?: string | undefined;
}

export interface DraftResult {
  /** Position in the submitted `drafts` array; results always come back in input order. */
  index: number;
  recipient: string;
  internalDraftId?: string | undefined;
  mailboxId?: string | undefined;
  provider?: MailboxProvider | undefined;
  providerDraftId?: string | undefined;
  providerMessageId?: string | undefined;
  providerWebUrl?: string | undefined;
  sendingIdentityEmail?: string | undefined;
  status: DraftOutcomeStatus;
  duplicatePrevented: boolean;
  errorCode?: GatewayErrorCode | undefined;
  /** What to do about `errorCode`, present where the code alone does not say it. */
  errorMessage?: string | undefined;
}

export interface CreateOutreachDraftsResult {
  campaignId: string;
  sequenceStep: number;
  routingMode: RoutingMode;
  results: DraftResult[];
  summary: {
    requested: number;
    created: number;
    duplicates: number;
    failed: number;
    /** Drafts created per mailbox during this call. */
    byMailbox: Record<string, number>;
  };
}

export interface DraftSummary {
  internalDraftId: string;
  mailboxId: string;
  provider: MailboxProvider;
  status: DraftRowStatus;
  providerDraftId?: string | undefined;
  providerMessageId?: string | undefined;
  providerWebUrl?: string | undefined;
  sendingIdentityEmail?: string | undefined;
  providerSentMessageId?: string | undefined;
  sentAt?: string | undefined;
  campaignId?: string | undefined;
  prospectId?: string | undefined;
  recipient?: string | undefined;
  sequenceStep?: number | undefined;
  sourceMessageId?: string | undefined;
  lastErrorCode?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface DraftStatusResult extends DraftSummary {
  /** False when the provider no longer holds the draft (deleted in Gmail/Outlook). */
  stillExists: boolean;
  /** Set when the liveness check itself failed; `stillExists` stays optimistic then. */
  providerCheckErrorCode?: GatewayErrorCode | undefined;
  /** Present while the row waits for `reconcile_draft_send` to settle an uncertain send. */
  reconciliationHint?: string | undefined;
}

export interface AdoptExternalDraftOutcome {
  index: number;
  providerMessageId: string;
  status: 'adopted' | 'alreadyManaged' | 'failed';
  draft?: DraftSummary | undefined;
  errorCode?: GatewayErrorCode | undefined;
  /** What to do about `errorCode`, present where the code alone does not say it. */
  errorMessage?: string | undefined;
}

export interface AdoptExternalDraftsResult {
  mailboxId: string;
  results: AdoptExternalDraftOutcome[];
  summary: { requested: number; adopted: number; alreadyManaged: number; failed: number };
}

export interface DeleteOutreachDraftsResult {
  results: Array<{
    index: number;
    internalDraftId: string;
    status: 'deleted' | 'failed';
    draft?: DraftSummary | undefined;
    errorCode?: GatewayErrorCode | undefined;
    /** What to do about `errorCode`, present where the code alone does not say it. */
    errorMessage?: string | undefined;
  }>;
  summary: { requested: number; deleted: number; failed: number };
}
