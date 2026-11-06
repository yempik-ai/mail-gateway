// Limits and timing constants of the draft service.

export const MAX_DRAFTS_PER_CALL = 15;
export const MAX_ADOPTIONS_PER_CALL = 50;
export const MAX_DELETIONS_PER_CALL = 50;
// Defined with the mailbox registry, which applies them to a new mailbox;
// re-exported so the draft service's public surface keeps them.
export { DEFAULT_DAILY_DRAFT_LIMIT, DEFAULT_PER_RUN_DRAFT_LIMIT } from '@yempik/core';
export const DRAFT_PROVIDER_TIMEOUT_MS = 20_000;
/**
 * Time budget of one batch call (create, adopt or delete), measured from its start. The
 * serverless function hosting it is killed at 60 s (vercel.json maxDuration);
 * the budget leaves room for the request around the batch.
 */
export const DEFAULT_BATCH_DEADLINE_MS = 45_000;
/**
 * Time kept free, on top of one provider timeout, before a batch starts
 * another entry: it covers the claim, the signature lookup and the writes that
 * finalize the draft once the provider answers.
 */
export const BATCH_DEADLINE_MARGIN_MS = 5_000;
export const BATCH_TIME_BUDGET_EXCEEDED_MESSAGE =
  'Batch time budget exhausted; retry the remaining drafts';
/**
 * A `sending` row this many provider timeouts old is a crashed claim, not an
 * in-flight send, and becomes reconcilable.
 */
export const STALE_SENDING_TIMEOUT_FACTOR = 2;
/**
 * Zoho keeps the draft after a send, so an empty Sent folder is the only
 * evidence of non-delivery there; the index needs a grace period before that
 * absence means anything.
 */
export const ZOHO_NOT_SENT_MIN_AGE_MS = 5 * 60_000;
/** Clock-skew allowance subtracted from the lower date bound of the Sent search. */
export const RECONCILE_CLOCK_SKEW_MS = 60_000;
/** Sent-folder candidates examined per reconciliation. */
export const RECONCILE_SEARCH_LIMIT = 25;
/** Length of the sha256 prefix that identifies reply content in its idempotency key. */
export const CONTENT_HASH_LENGTH = 16;
