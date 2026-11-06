// Idempotency keys and the claim that makes a key the caller's.

import { createHash } from 'node:crypto';
import { rawDraftBody } from './compose.js';
import { CONTENT_HASH_LENGTH } from './constants.js';
import { isLiveDraft, normalizeRecipient } from './records.js';
import type { DraftStore } from './store.js';
import type { CreateReplyDraftInput, DraftRecord, NewDraftRow } from './types.js';

/** Outreach key: campaign + normalized recipient + sequence step. */
export function outreachIdempotencyKey(
  campaignId: string,
  recipient: string,
  sequenceStep: number,
): string {
  return `${campaignId}:${normalizeRecipient(recipient)}:${sequenceStep}`;
}

export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, CONTENT_HASH_LENGTH);
}

/** Reply key: mailbox + source message + reply mode + content hash. */
export function replyIdempotencyKey(input: CreateReplyDraftInput): string {
  const hash = contentHash(`${input.fromAddress ?? ''}\0${rawDraftBody(input)}`);
  return `${input.mailboxId}:${input.sourceMessageId}:${input.replyMode}:${hash}`;
}

export type DraftRowClaim =
  { claimed: DraftRecord } | { duplicate: DraftRecord } | { conflict: true };

/**
 * Claims the idempotency key. Returns the existing row as a duplicate when a
 * live draft already answers for it, otherwise a `creating` row that the
 * caller owns until it finalizes or fails it. The unique constraints on
 * `drafts` are the concurrency lock: losing the insert race re-reads instead
 * of creating a second draft in the mailbox.
 */
export async function claimDraftRow(store: DraftStore, row: NewDraftRow): Promise<DraftRowClaim> {
  const existing = await store.findDraftByIdempotencyKey(row.idempotencyKey);
  if (existing !== undefined) {
    if (isLiveDraft(existing.status)) return { duplicate: existing };
    // `failed` and `deleted` rows no longer answer for the key: re-arm the
    // same row rather than inserting a second one under the unique index.
    const reclaimed = await store.reclaimDraft(existing.id);
    if (reclaimed === undefined) {
      const settled = await store.findDraftByIdempotencyKey(row.idempotencyKey);
      return settled === undefined ? { conflict: true } : { duplicate: settled };
    }
    return { claimed: reclaimed };
  }

  const inserted = await store.insertCreatingDraft(row);
  if (inserted !== undefined) return { claimed: inserted };

  const raced = await store.findDraftByIdempotencyKey(row.idempotencyKey);
  return raced === undefined ? { conflict: true } : { duplicate: raced };
}
