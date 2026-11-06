// Draft orchestration and autonomous delivery. A message can only be delivered
// after it exists as a gateway-owned provider draft.
//
// Everything provider-specific arrives through `DraftAdapterFactory`, and every
// row this service touches goes through `DraftStore`, so routing, idempotency
// and limit decisions stay unit-testable without a live database or provider.
//
// Module map:
//   types.ts, store.ts     records, inputs/results, and the persistence contract
//   constants.ts           per-call limits and provider timing
//   records.ts, errors.ts  pure record helpers and gateway error helpers
//   idempotency.ts         idempotency keys and the row claim built on them
//   compose.ts             body rendering, signatures, sending identity
//   mailbox.ts             mailbox/adapter/draft guards shared by operations
//   routing.ts             round-robin mailbox router for outreach batches
//   create.ts              outreach batches and reply drafts
//   update.ts              in-place draft edits
//   delete-adopt.ts        adoption of provider drafts, deletion
//   send.ts                send claim, provider call and settlement
//   reconcile.ts           settling sends whose outcome is unknown
//   queries.ts             listings and draft status
//   service.ts             `createDraftService`, binding the operations together
//   store-postgres*.ts     the drizzle-backed `DraftStore`
//
// This barrel is the public surface; the other exports of these modules are
// internal to the folder.

export {
  BATCH_DEADLINE_MARGIN_MS,
  BATCH_TIME_BUDGET_EXCEEDED_MESSAGE,
  CONTENT_HASH_LENGTH,
  DEFAULT_BATCH_DEADLINE_MS,
  DEFAULT_DAILY_DRAFT_LIMIT,
  DEFAULT_PER_RUN_DRAFT_LIMIT,
  DRAFT_PROVIDER_TIMEOUT_MS,
  MAX_ADOPTIONS_PER_CALL,
  MAX_DELETIONS_PER_CALL,
  MAX_DRAFTS_PER_CALL,
  RECONCILE_CLOCK_SKEW_MS,
  RECONCILE_SEARCH_LIMIT,
  STALE_SENDING_TIMEOUT_FACTOR,
  ZOHO_NOT_SENT_MIN_AGE_MS,
} from './constants.js';
export type {
  AdoptExternalDraftOutcome,
  AdoptExternalDraftsInput,
  AdoptExternalDraftsResult,
  CreateOutreachDraftsInput,
  CreateOutreachDraftsResult,
  CreateReplyDraftInput,
  DeleteOutreachDraftInput,
  DeleteOutreachDraftsInput,
  DeleteOutreachDraftsResult,
  DraftAdapterFactory,
  DraftBodyInput,
  DraftMailboxRecord,
  DraftMessageReferenceRecord,
  DraftOperationRow,
  DraftOutcomeStatus,
  DraftRecord,
  DraftResult,
  DraftRowStatus,
  DraftStatusResult,
  DraftSummary,
  GetDraftStatusInput,
  ListCampaignDraftsInput,
  MessageReferenceRow,
  NewDraftRow,
  OutreachDraftInput,
  ProspectAssignmentRecord,
  ReconcileDraftSendInput,
  ReconcileDraftSendResult,
  ReconcileSendEvidence,
  ReconcileSendOutcome,
  RoutingMode,
  SendDraftInput,
  SendDraftResult,
  UpdateOutreachDraftInput,
  UpdateOutreachDraftResult,
} from './types.js';
export type {
  DraftProviderIdentifiers,
  DraftSendClaim,
  DraftStore,
  FinalizeDraftCreationInput,
  ReleaseDraftSendInput,
  ResolveUnknownSendInput,
} from './store.js';
export { providedBodyFields, rawDraftBody } from './compose.js';
export { contentHash, outreachIdempotencyKey, replyIdempotencyKey } from './idempotency.js';
export { isValidRecipient, normalizeRecipient, toDraftSummary, usageDateOf } from './records.js';
export {
  createDraftRouter,
  routableMailboxes,
  type DraftRouter,
  type RoutingAllocation,
  type RoutingCandidate,
} from './routing.js';
export { createDraftService, type DraftService, type DraftServiceOptions } from './service.js';
export { createDatabaseDraftStore } from './store-postgres.js';
