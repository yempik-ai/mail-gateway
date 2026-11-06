// The time budget of a batch operation. The serverless function hosting a
// call is killed at its platform limit (vercel.json maxDuration), and a batch
// of sequential provider calls, each bounded by its own timeout, can outlast
// it. Every batch therefore starts an entry only while the budget still covers
// one full provider timeout plus the writes around it; the entries it can no
// longer cover fail retryably instead of being cut off mid-way.

import { BATCH_DEADLINE_MARGIN_MS, BATCH_TIME_BUDGET_EXCEEDED_MESSAGE } from './constants.js';
import type { DraftServiceContext } from './context.js';

export interface BatchBudget {
  /** True while one more entry can still finish within the budget. */
  canStartEntry(): boolean;
}

/** The budget runs from `startedAt`, which callers take before their first await. */
export function startBatchBudget(
  ctx: Pick<DraftServiceContext, 'batchDeadlineMs' | 'timeoutMs' | 'now'>,
  startedAt: Date = ctx.now(),
): BatchBudget {
  return {
    canStartEntry() {
      const remainingMs = ctx.batchDeadlineMs - (ctx.now().getTime() - startedAt.getTime());
      return remainingMs >= ctx.timeoutMs + BATCH_DEADLINE_MARGIN_MS;
    },
  };
}

/** The per-entry failure of an entry the budget could not cover. */
export const BATCH_BUDGET_FAILURE = {
  status: 'failed',
  errorCode: 'BATCH_TIME_BUDGET_EXCEEDED',
  errorMessage: BATCH_TIME_BUDGET_EXCEEDED_MESSAGE,
} as const;
