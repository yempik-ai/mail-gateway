// Mailbox selection for outreach batches: which mailboxes may take
// new drafts, and a round-robin router that enforces per-run and daily caps.

import type { DraftMailboxRecord } from './types.js';

export interface RoutingCandidate {
  mailboxId: string;
  perRunLimit: number;
  dailyRemaining: number;
}

export type RoutingAllocation =
  { mailboxId: string } | { errorCode: 'PER_RUN_LIMIT_REACHED' | 'DAILY_LIMIT_REACHED' };

export interface DraftRouter {
  /** Deterministic round-robin over the candidates, in the order they were given. */
  next(): RoutingAllocation;
  /** Sticky path: consume capacity on one specific mailbox, never rerouting. */
  reserve(mailboxId: string): RoutingAllocation;
  /**
   * Gives back one slot taken by `next` or `reserve` for an entry that failed
   * before reaching the provider. The round-robin cursor is not rewound.
   */
  release(mailboxId: string): void;
  allocations(): Record<string, number>;
}

/**
 * Round-robin router. Candidates must already be filtered to
 * enabled + connected mailboxes and ordered by routing priority; the cursor
 * advances one slot per assignment, so 8 drafts over 3 mailboxes give 3/3/2.
 *
 * Both caps are enforced in either routing mode: `perRunLimit` is the mailbox's
 * own per-call ceiling and `dailyRemaining` what is left of its daily quota.
 */
export function createDraftRouter(candidates: RoutingCandidate[]): DraftRouter {
  const state = candidates.map((candidate) => ({ ...candidate, used: 0 }));
  let cursor = 0;

  const hasCapacity = (entry: { used: number; perRunLimit: number; dailyRemaining: number }) =>
    entry.used < entry.perRunLimit && entry.used < entry.dailyRemaining;

  const exhaustionCode = (): 'PER_RUN_LIMIT_REACHED' | 'DAILY_LIMIT_REACHED' =>
    state.some((entry) => entry.used < entry.dailyRemaining)
      ? 'PER_RUN_LIMIT_REACHED'
      : 'DAILY_LIMIT_REACHED';

  return {
    next() {
      for (let offset = 0; offset < state.length; offset += 1) {
        const index = (cursor + offset) % state.length;
        const entry = state[index];
        if (entry === undefined || !hasCapacity(entry)) continue;
        entry.used += 1;
        cursor = index + 1;
        return { mailboxId: entry.mailboxId };
      }
      return { errorCode: exhaustionCode() };
    },
    reserve(mailboxId) {
      const entry = state.find((candidate) => candidate.mailboxId === mailboxId);
      if (entry === undefined) return { errorCode: 'DAILY_LIMIT_REACHED' };
      if (!hasCapacity(entry)) {
        return {
          errorCode:
            entry.used < entry.dailyRemaining ? 'PER_RUN_LIMIT_REACHED' : 'DAILY_LIMIT_REACHED',
        };
      }
      entry.used += 1;
      return { mailboxId: entry.mailboxId };
    },
    release(mailboxId) {
      const entry = state.find((candidate) => candidate.mailboxId === mailboxId);
      if (entry !== undefined && entry.used > 0) entry.used -= 1;
    },
    allocations() {
      return Object.fromEntries(state.map((entry) => [entry.mailboxId, entry.used]));
    },
  };
}

/** Enabled + connected mailboxes only, ordered by routing priority then id. */
export function routableMailboxes(rows: DraftMailboxRecord[]): DraftMailboxRecord[] {
  return rows
    .filter((row) => row.enabled && row.connectionStatus === 'connected')
    .sort((left, right) =>
      left.routingPriority === right.routingPriority
        ? left.id.localeCompare(right.id)
        : left.routingPriority - right.routingPriority,
    );
}
