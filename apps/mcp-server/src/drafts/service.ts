// The draft service facade: resolves the options once into a context and
// binds every operation to it.

import type { SignatureStore } from '../signature-store.js';
import {
  DEFAULT_BATCH_DEADLINE_MS,
  DRAFT_PROVIDER_TIMEOUT_MS,
  STALE_SENDING_TIMEOUT_FACTOR,
} from './constants.js';
import type { DraftServiceContext } from './context.js';
import { createOutreachDrafts, createReplyDraft } from './create.js';
import { adoptExternalDrafts, deleteOutreachDraft, deleteOutreachDrafts } from './delete-adopt.js';
import { getDraftStatus, listCampaignDrafts } from './queries.js';
import { reconcileDraftSend } from './reconcile.js';
import { sendDraft } from './send.js';
import type { DraftStore } from './store.js';
import type {
  AdoptExternalDraftsInput,
  AdoptExternalDraftsResult,
  CreateOutreachDraftsInput,
  CreateOutreachDraftsResult,
  CreateReplyDraftInput,
  DeleteOutreachDraftInput,
  DeleteOutreachDraftsInput,
  DeleteOutreachDraftsResult,
  DraftAdapterFactory,
  DraftResult,
  DraftStatusResult,
  DraftSummary,
  GetDraftStatusInput,
  ListCampaignDraftsInput,
  ReconcileDraftSendInput,
  ReconcileDraftSendResult,
  SendDraftInput,
  SendDraftResult,
  UpdateOutreachDraftInput,
  UpdateOutreachDraftResult,
} from './types.js';
import { updateOutreachDraft } from './update.js';

export interface DraftServiceOptions {
  store: DraftStore;
  draftAdapterFactory: DraftAdapterFactory;
  correlationId: string;
  /** Signatures and display names per sending identity; without it drafts go out unsigned. */
  signatureStore?: SignatureStore | undefined;
  /** IANA time zone of the attribution line quoted below replies (adapter default: UTC). */
  quoteTimeZone?: string | undefined;
  timeoutMs?: number | undefined;
  /**
   * Time budget of each batch operation (`createOutreachDrafts`,
   * `adoptExternalDrafts`, `deleteOutreachDrafts`), measured from the start of
   * the call (default `DEFAULT_BATCH_DEADLINE_MS`). Entries the budget can no
   * longer cover fail with BATCH_TIME_BUDGET_EXCEEDED before touching the
   * provider.
   */
  batchDeadlineMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface DraftService {
  createOutreachDrafts(input: CreateOutreachDraftsInput): Promise<CreateOutreachDraftsResult>;
  createReplyDraft(input: CreateReplyDraftInput): Promise<DraftResult>;
  adoptExternalDrafts(input: AdoptExternalDraftsInput): Promise<AdoptExternalDraftsResult>;
  updateOutreachDraft(input: UpdateOutreachDraftInput): Promise<UpdateOutreachDraftResult>;
  deleteOutreachDraft(input: DeleteOutreachDraftInput): Promise<DraftSummary>;
  deleteOutreachDrafts(input: DeleteOutreachDraftsInput): Promise<DeleteOutreachDraftsResult>;
  listCampaignDrafts(input: ListCampaignDraftsInput): Promise<DraftSummary[]>;
  getDraftStatus(input: GetDraftStatusInput): Promise<DraftStatusResult>;
  sendDraft(input: SendDraftInput): Promise<SendDraftResult>;
  reconcileDraftSend(input: ReconcileDraftSendInput): Promise<ReconcileDraftSendResult>;
}

export function createDraftService(options: DraftServiceOptions): DraftService {
  const timeoutMs = options.timeoutMs ?? DRAFT_PROVIDER_TIMEOUT_MS;
  const ctx: DraftServiceContext = {
    store: options.store,
    draftAdapterFactory: options.draftAdapterFactory,
    correlationId: options.correlationId,
    signatureStore: options.signatureStore,
    quoteTimeZone: options.quoteTimeZone,
    timeoutMs,
    batchDeadlineMs: options.batchDeadlineMs ?? DEFAULT_BATCH_DEADLINE_MS,
    now: options.now ?? (() => new Date()),
    staleSendingAfterMs: STALE_SENDING_TIMEOUT_FACTOR * timeoutMs,
  };

  return {
    createOutreachDrafts: (input) => createOutreachDrafts(ctx, input),
    createReplyDraft: (input) => createReplyDraft(ctx, input),
    adoptExternalDrafts: (input) => adoptExternalDrafts(ctx, input),
    updateOutreachDraft: (input) => updateOutreachDraft(ctx, input),
    sendDraft: (input) => sendDraft(ctx, input),
    reconcileDraftSend: (input) => reconcileDraftSend(ctx, input),
    deleteOutreachDraft: (input) => deleteOutreachDraft(ctx, input),
    deleteOutreachDrafts: (input) => deleteOutreachDrafts(ctx, input),
    listCampaignDrafts: (input) => listCampaignDrafts(ctx, input),
    getDraftStatus: (input) => getDraftStatus(ctx, input),
  };
}
