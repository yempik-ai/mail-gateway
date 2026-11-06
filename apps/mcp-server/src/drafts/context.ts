// The dependencies every draft operation shares. `createDraftService` resolves
// them once from `DraftServiceOptions`; the operation modules take them as
// their first argument instead of closing over them.

import type { SignatureStore } from '../signature-store.js';
import type { DraftStore } from './store.js';
import type { DraftAdapterFactory } from './types.js';

export interface DraftServiceContext {
  store: DraftStore;
  draftAdapterFactory: DraftAdapterFactory;
  correlationId: string;
  signatureStore: SignatureStore | undefined;
  quoteTimeZone: string | undefined;
  /** Upper bound on every single provider call. */
  timeoutMs: number;
  /** Time budget of one batch call, measured from its start (see batch-budget.ts). */
  batchDeadlineMs: number;
  now: () => Date;
  /** Age at which a `sending` claim counts as crashed rather than in flight. */
  staleSendingAfterMs: number;
}
