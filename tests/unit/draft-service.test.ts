import { describe, expect, it } from 'vitest';
import { GatewayError, gatewayErrorRetryable } from '../../packages/core/src/index.js';
import type {
  GatewayErrorCode,
  MailDraftAdapter,
  MailProviderAdapter,
  NormalizedEmail,
  NormalizedSearchQuery,
  ProviderDraftInput,
  ProviderDraftSnapshot,
  ProviderDraftUpdate,
  ProviderReplyDraftInput,
} from '../../packages/core/src/index.js';
import { DELIVERY_CRITICAL_SCOPES } from '../../packages/oauth/src/index.js';
import {
  BATCH_DEADLINE_MARGIN_MS,
  BATCH_TIME_BUDGET_EXCEEDED_MESSAGE,
  DRAFT_PROVIDER_TIMEOUT_MS,
  MAX_DRAFTS_PER_CALL,
  createDraftRouter,
  createDraftService,
  outreachIdempotencyKey,
  contentHash,
  replyIdempotencyKey,
  routableMailboxes,
  type CreateOutreachDraftsInput,
  type DraftAdapterFactory,
  type DraftMailboxRecord,
  type DraftOperationRow,
  type DraftRecord,
  type DraftStore,
  type MessageReferenceRow,
  type NewDraftRow,
  type OutreachDraftInput,
  type ProspectAssignmentRecord,
} from '../../apps/mcp-server/src/draft-service.js';
import type { SignatureStore, StoredSignature } from '../../apps/mcp-server/src/signature-store.js';

const CORRELATION_ID = '8b4d1f92-0c3a-4c1d-9f56-2b7a1c8e4d33';

function mailbox(overrides: Partial<DraftMailboxRecord> & { id: string }): DraftMailboxRecord {
  const row: DraftMailboxRecord = {
    provider: 'gmail',
    emailAddress: `${overrides.id}@example.com`,
    aliases: [],
    enabled: true,
    connectionStatus: 'connected',
    grantedScopes: [],
    perRunDraftLimit: 5,
    dailyDraftLimit: 25,
    dailySendLimit: 25,
    dailySendLimitsByIdentity: {},
    routingPriority: 1,
    ...overrides,
  };
  return {
    ...row,
    // A mailbox is connected with a full grant unless the test says otherwise.
    grantedScopes:
      row.grantedScopes.length > 0
        ? row.grantedScopes
        : [...DELIVERY_CRITICAL_SCOPES[row.provider]],
    dailySendLimitsByIdentity:
      Object.keys(row.dailySendLimitsByIdentity).length > 0
        ? row.dailySendLimitsByIdentity
        : { [row.emailAddress.toLowerCase()]: row.dailySendLimit },
  };
}

interface FakeStoreState {
  drafts: DraftRecord[];
  assignments: ProspectAssignmentRecord[];
  usage: Record<string, number>;
  sentUsage: Record<string, number>;
  sentUsageByIdentity: Record<string, number>;
  operations: DraftOperationRow[];
  references: MessageReferenceRow[];
  campaigns: string[];
  /** When set, the next insert loses the unique race and this row lands instead. */
  raceOnce?: DraftRecord;
}

interface FakeStore {
  store: DraftStore;
  state: FakeStoreState;
}

/**
 * In-memory DraftStore that reproduces the two unique constraints the real
 * table carries: drafts.idempotency_key and (campaign, recipient, step).
 */
function createFakeStore(
  rows: DraftMailboxRecord[],
  seed: Partial<
    Pick<FakeStoreState, 'drafts' | 'assignments' | 'usage' | 'sentUsage' | 'sentUsageByIdentity'>
  > = {},
): FakeStore {
  const state: FakeStoreState = {
    drafts: [...(seed.drafts ?? [])],
    assignments: [...(seed.assignments ?? [])],
    usage: { ...(seed.usage ?? {}) },
    sentUsage: { ...(seed.sentUsage ?? {}) },
    sentUsageByIdentity: { ...(seed.sentUsageByIdentity ?? {}) },
    operations: [],
    references: [],
    campaigns: [],
  };
  let sequence = 0;

  const find = (internalDraftId: string): DraftRecord => {
    const row = state.drafts.find((draft) => draft.id === internalDraftId);
    if (row === undefined) throw new Error(`unknown draft ${internalDraftId}`);
    return row;
  };

  const store: DraftStore = {
    listMailboxes: () => Promise.resolve(rows),
    ensureCampaign(campaignId) {
      if (!state.campaigns.includes(campaignId)) state.campaigns.push(campaignId);
      return Promise.resolve();
    },
    listProspectAssignments: (campaignId) =>
      Promise.resolve(state.assignments.filter((entry) => entry.campaignId === campaignId)),
    saveProspectAssignment(assignment) {
      const exists = state.assignments.some(
        (entry) =>
          entry.campaignId === assignment.campaignId &&
          entry.normalizedRecipientEmail === assignment.normalizedRecipientEmail,
      );
      if (!exists) state.assignments.push(assignment);
      return Promise.resolve();
    },
    dailyUsage: () => Promise.resolve({ ...state.usage }),
    findDraftByIdempotencyKey: (key) =>
      Promise.resolve(state.drafts.find((draft) => draft.idempotencyKey === key)),
    findDraftById: (id) => Promise.resolve(state.drafts.find((draft) => draft.id === id)),
    findDraftByProviderDraftId: (mailboxId, providerDraftId) =>
      Promise.resolve(
        state.drafts.find(
          (draft) => draft.mailboxId === mailboxId && draft.providerDraftId === providerDraftId,
        ),
      ),
    listCampaignDrafts: (campaignId, status) =>
      Promise.resolve(
        state.drafts.filter(
          (draft) =>
            draft.campaignId === campaignId && (status === undefined || draft.status === status),
        ),
      ),
    insertCreatingDraft(row: NewDraftRow) {
      if (state.raceOnce !== undefined) {
        state.drafts.push(state.raceOnce);
        delete state.raceOnce;
        return Promise.resolve(undefined);
      }
      const conflict = state.drafts.some(
        (draft) =>
          draft.idempotencyKey === row.idempotencyKey ||
          (row.campaignId !== undefined &&
            draft.campaignId === row.campaignId &&
            draft.normalizedRecipientEmail === row.normalizedRecipientEmail &&
            draft.sequenceStep === row.sequenceStep),
      );
      if (conflict) return Promise.resolve(undefined);
      sequence += 1;
      const record: DraftRecord = { ...row, id: `draft-${sequence}`, status: 'creating' };
      state.drafts.push(record);
      return Promise.resolve(record);
    },
    reclaimDraft(internalDraftId) {
      const row = find(internalDraftId);
      if (row.status !== 'failed' && row.status !== 'deleted') return Promise.resolve(undefined);
      row.status = 'creating';
      row.lastErrorCode = undefined;
      return Promise.resolve(row);
    },
    finalizeDraftCreation(input) {
      const row = find(input.draftId);
      row.status = 'created';
      row.providerDraftId = input.providerDraftId;
      row.providerMessageId = input.providerMessageId;
      row.providerWebUrl = input.providerWebUrl;
      row.sendingIdentityEmail = input.sendingIdentityEmail;
      row.lastErrorCode = undefined;
      if (input.usageDate !== undefined) {
        state.usage[input.mailboxId] = (state.usage[input.mailboxId] ?? 0) + 1;
      }
      if (input.messageReference !== undefined) state.references.push(input.messageReference);
      return Promise.resolve(row);
    },
    markDraftFailed(internalDraftId, errorCode) {
      const row = find(internalDraftId);
      row.status = 'failed';
      row.lastErrorCode = errorCode;
      return Promise.resolve();
    },
    markDraftUpdated(internalDraftId, identifiers) {
      const row = find(internalDraftId);
      row.status = 'updated';
      if (identifiers.providerDraftId !== undefined) {
        row.providerDraftId = identifiers.providerDraftId;
      }
      if (identifiers.sendingIdentityEmail !== undefined) {
        row.sendingIdentityEmail = identifiers.sendingIdentityEmail;
      }
      return Promise.resolve(row);
    },
    markDraftDeleted(internalDraftId) {
      const row = find(internalDraftId);
      row.status = 'deleted';
      return Promise.resolve(row);
    },
    claimDraftForSending(internalDraftId, _usageDate, at) {
      const row = find(internalDraftId);
      if (row.status !== 'created' && row.status !== 'updated') {
        return Promise.resolve({ status: 'not_claimable' as const, draft: row });
      }
      const mailboxRow = rows.find((candidate) => candidate.id === row.mailboxId);
      const identity = row.sendingIdentityEmail ?? mailboxRow?.emailAddress.toLowerCase() ?? '';
      const identityKey = `${row.mailboxId}:${identity}`;
      const identityLimit =
        mailboxRow?.dailySendLimitsByIdentity[identity] ?? mailboxRow?.dailySendLimit ?? 0;
      if (
        (state.sentUsage[row.mailboxId] ?? 0) >= (mailboxRow?.dailySendLimit ?? 0) ||
        (state.sentUsageByIdentity[identityKey] ?? 0) >= identityLimit
      ) {
        return Promise.resolve({ status: 'daily_limit' as const });
      }
      const previousStatus = row.status;
      row.status = 'sending';
      row.updatedAt = at.toISOString();
      state.sentUsage[row.mailboxId] = (state.sentUsage[row.mailboxId] ?? 0) + 1;
      state.sentUsageByIdentity[identityKey] = (state.sentUsageByIdentity[identityKey] ?? 0) + 1;
      return Promise.resolve({ status: 'claimed' as const, draft: row, previousStatus });
    },
    finalizeDraftSend(internalDraftId, receipt, at) {
      const row = find(internalDraftId);
      const reference = state.references.find(
        (candidate) =>
          candidate.mailboxId === row.mailboxId &&
          candidate.providerMessageId === row.providerMessageId,
      );
      row.status = 'sent';
      row.providerSentMessageId = receipt.providerMessageId;
      row.providerWebUrl = undefined;
      row.sentAt = at.toISOString();
      row.lastErrorCode = undefined;
      if (reference !== undefined) {
        reference.providerMessageId = receipt.providerMessageId ?? reference.providerMessageId;
        reference.threadId = receipt.threadId ?? reference.threadId;
        reference.conversationId = receipt.conversationId ?? reference.conversationId;
        reference.internetMessageId = receipt.internetMessageId;
        reference.messageAt = at;
      }
      return Promise.resolve(row);
    },
    releaseDraftSend(input) {
      const row = find(input.draftId);
      row.status = input.uncertain ? 'send_unknown' : input.previousStatus;
      row.lastErrorCode = input.errorCode;
      if (!input.uncertain) {
        state.sentUsage[row.mailboxId] = Math.max((state.sentUsage[row.mailboxId] ?? 0) - 1, 0);
        const identity = row.sendingIdentityEmail ?? '';
        const identityKey = `${row.mailboxId}:${identity}`;
        state.sentUsageByIdentity[identityKey] = Math.max(
          (state.sentUsageByIdentity[identityKey] ?? 0) - 1,
          0,
        );
      }
      return Promise.resolve(row);
    },
    resolveUnknownSend(input) {
      const row = find(input.draftId);
      if (row.status !== 'sending' && row.status !== 'send_unknown') {
        throw new Error(`draft ${input.draftId} is not awaiting reconciliation`);
      }
      if (input.outcome === 'sent') {
        row.status = 'sent';
        row.providerSentMessageId = input.receipt.providerMessageId;
        row.providerWebUrl = undefined;
        row.sentAt = input.at.toISOString();
        row.lastErrorCode = undefined;
        return Promise.resolve(row);
      }
      row.status = 'created';
      state.sentUsage[row.mailboxId] = Math.max((state.sentUsage[row.mailboxId] ?? 0) - 1, 0);
      const identityKey = `${row.mailboxId}:${row.sendingIdentityEmail ?? ''}`;
      state.sentUsageByIdentity[identityKey] = Math.max(
        (state.sentUsageByIdentity[identityKey] ?? 0) - 1,
        0,
      );
      return Promise.resolve(row);
    },
    findDraftMessageReference(internalDraftId) {
      const row = state.drafts.find((draft) => draft.id === internalDraftId);
      const reference = state.references.find(
        (candidate) =>
          candidate.mailboxId === row?.mailboxId &&
          candidate.providerMessageId === row.providerMessageId,
      );
      if (reference === undefined) return Promise.resolve(undefined);
      return Promise.resolve({
        ...(reference.normalizedRecipient === undefined
          ? {}
          : { normalizedRecipient: reference.normalizedRecipient }),
        ...(reference.subject === undefined ? {} : { subject: reference.subject }),
      });
    },
    recordDraftOperation(row) {
      state.operations.push(row);
      return Promise.resolve();
    },
  };

  return { store, state };
}

interface AdapterBehaviour {
  fail?: Error;
  getDraftFail?: Error;
  deleteFail?: Error;
  sendFail?: Error;
  searchFail?: Error;
  /** Messages the Sent folder answers with, before the service filters them. */
  sentMessages?: NormalizedEmail[];
  snapshot?: Partial<ProviderDraftSnapshot>;
  /** Extra fields the adapter reports on updateDraft (e.g. quoteRebuilt). */
  updateSnapshot?: Partial<ProviderDraftSnapshot>;
}

interface AdapterCalls {
  create: ProviderDraftInput[];
  reply: ProviderReplyDraftInput[];
  update: { providerDraftId: string; update: ProviderDraftUpdate }[];
  get: string[];
  getByMessage: string[];
  send: string[];
  remove: string[];
  search: NormalizedSearchQuery[];
}

interface FakeAdapters {
  factory: DraftAdapterFactory;
  calls: Record<string, AdapterCalls>;
}

function createAdapters(behaviour: Record<string, AdapterBehaviour> = {}): FakeAdapters {
  const calls: Record<string, AdapterCalls> = {};
  const callsFor = (mailboxId: string): AdapterCalls => {
    calls[mailboxId] ??= {
      create: [],
      reply: [],
      update: [],
      get: [],
      getByMessage: [],
      send: [],
      remove: [],
      search: [],
    };
    return calls[mailboxId];
  };

  const factory: DraftAdapterFactory = (target) => {
    const config = behaviour[target.id] ?? {};
    const seen = callsFor(target.id);
    let created = 0;
    const snapshot = (): ProviderDraftSnapshot => {
      created += 1;
      return {
        providerDraftId: `${target.id}-draft-${created}`,
        providerMessageId: `${target.id}-message-${created}`,
        threadId: `${target.id}-thread-${created}`,
        providerWebUrl: `https://mail.example/${target.id}/${created}`,
        ...config.snapshot,
      };
    };
    // The composition root wires one object per mailbox for both contracts, so
    // the fake carries the Sent search that reconciliation reads.
    const adapter: MailDraftAdapter & Pick<MailProviderAdapter, 'searchEmails'> = {
      mailboxId: target.id,
      provider: target.provider,
      searchEmails(query) {
        seen.search.push(query);
        return config.searchFail === undefined
          ? Promise.resolve({ items: config.sentMessages ?? [] })
          : Promise.reject(config.searchFail);
      },
      createDraft(input) {
        seen.create.push(input);
        return config.fail === undefined
          ? Promise.resolve(snapshot())
          : Promise.reject(config.fail);
      },
      createReplyDraft(input) {
        seen.reply.push(input);
        return config.fail === undefined
          ? Promise.resolve(snapshot())
          : Promise.reject(config.fail);
      },
      updateDraft(providerDraftId, update) {
        seen.update.push({ providerDraftId, update });
        return config.fail === undefined
          ? Promise.resolve({ ...config.updateSnapshot, providerDraftId })
          : Promise.reject(config.fail);
      },
      getDraft(providerDraftId) {
        seen.get.push(providerDraftId);
        return config.getDraftFail === undefined
          ? Promise.resolve({ providerDraftId })
          : Promise.reject(config.getDraftFail);
      },
      getDraftByMessageId(providerMessageId) {
        seen.getByMessage.push(providerMessageId);
        return config.getDraftFail === undefined
          ? Promise.resolve({
              ...snapshot(),
              providerMessageId,
            })
          : Promise.reject(config.getDraftFail);
      },
      sendDraft(providerDraftId) {
        seen.send.push(providerDraftId);
        if (config.sendFail !== undefined) return Promise.reject(config.sendFail);
        const ordinal = providerDraftId.replace(`${target.id}-draft-`, '');
        return Promise.resolve({
          providerMessageId: `${providerDraftId}-sent`,
          threadId: `${target.id}-thread-${ordinal}`,
          conversationId: `${target.id}-thread-${ordinal}`,
          internetMessageId: `<${providerDraftId}-sent@example.com>`,
        });
      },
      deleteDraft(providerDraftId) {
        seen.remove.push(providerDraftId);
        const failure = config.deleteFail ?? config.fail;
        return failure === undefined ? Promise.resolve() : Promise.reject(failure);
      },
    };
    return adapter;
  };

  return { factory, calls };
}

const CLOCK = '2026-08-07T09:00:00.000Z';

function service(
  store: DraftStore,
  factory: DraftAdapterFactory,
  now: () => Date = () => new Date(CLOCK),
) {
  return createDraftService({
    store,
    draftAdapterFactory: factory,
    correlationId: CORRELATION_ID,
    now,
  });
}

function entry(to: string, overrides: Partial<OutreachDraftInput> = {}): OutreachDraftInput {
  return { to, subject: 'Hello', textBody: 'Body', ...overrides };
}

function batch(
  count: number,
  overrides: Partial<CreateOutreachDraftsInput> = {},
): CreateOutreachDraftsInput {
  return {
    campaignId: 'campaign-1',
    routingMode: 'distributed',
    drafts: Array.from({ length: count }, (_value, index) => entry(`p${index + 1}@example.com`)),
    ...overrides,
  };
}

async function captureError(operation: Promise<unknown>): Promise<GatewayError> {
  const result = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(GatewayError);
  return result as GatewayError;
}

function expectCode(error: GatewayError, code: GatewayErrorCode): void {
  expect(error.code).toBe(code);
}

describe('routing primitives', () => {
  it('orders routable mailboxes by routing priority and drops unusable ones', () => {
    const ordered = routableMailboxes([
      mailbox({ id: 'c', routingPriority: 3 }),
      mailbox({ id: 'a', routingPriority: 1 }),
      mailbox({ id: 'off', routingPriority: 0, enabled: false }),
      mailbox({ id: 'stale', routingPriority: 0, connectionStatus: 'expired' }),
      mailbox({ id: 'b', routingPriority: 2 }),
    ]);
    expect(ordered.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('spreads assignments round-robin and reports why capacity ran out', () => {
    const router = createDraftRouter([
      { mailboxId: 'a', perRunLimit: 1, dailyRemaining: 10 },
      { mailboxId: 'b', perRunLimit: 1, dailyRemaining: 0 },
    ]);
    expect(router.next()).toEqual({ mailboxId: 'a' });
    expect(router.next()).toEqual({ errorCode: 'PER_RUN_LIMIT_REACHED' });

    const exhausted = createDraftRouter([{ mailboxId: 'a', perRunLimit: 5, dailyRemaining: 0 }]);
    expect(exhausted.next()).toEqual({ errorCode: 'DAILY_LIMIT_REACHED' });
  });

  it('gives a released slot back to the mailbox', () => {
    const router = createDraftRouter([{ mailboxId: 'a', perRunLimit: 1, dailyRemaining: 10 }]);
    expect(router.reserve('a')).toEqual({ mailboxId: 'a' });
    router.release('a');
    expect(router.allocations()).toEqual({ a: 0 });
    expect(router.next()).toEqual({ mailboxId: 'a' });
    expect(router.next()).toEqual({ errorCode: 'PER_RUN_LIMIT_REACHED' });
  });
});

describe('createOutreachDrafts validation', () => {
  it('rejects a batch larger than the per-call maximum with INVALID_QUERY', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters();
    const error = await captureError(
      service(store, adapters.factory).createOutreachDrafts(batch(MAX_DRAFTS_PER_CALL + 1)),
    );
    expectCode(error, 'INVALID_QUERY');
    expect(adapters.calls['mb-a']).toBeUndefined();
  });

  it('requires mailboxId in explicit mode and validates the target mailbox', async () => {
    const rows = [
      mailbox({ id: 'mb-a' }),
      mailbox({ id: 'mb-off', enabled: false }),
      mailbox({ id: 'mb-stale', connectionStatus: 'expired' }),
    ];
    const { store } = createFakeStore(rows);
    const drafts = service(store, createAdapters().factory);

    expectCode(
      await captureError(drafts.createOutreachDrafts(batch(1, { routingMode: 'explicit' }))),
      'INVALID_QUERY',
    );
    expectCode(
      await captureError(
        drafts.createOutreachDrafts(batch(1, { routingMode: 'explicit', mailboxId: 'nope' })),
      ),
      'MAILBOX_NOT_FOUND',
    );
    expectCode(
      await captureError(
        drafts.createOutreachDrafts(batch(1, { routingMode: 'explicit', mailboxId: 'mb-off' })),
      ),
      'MAILBOX_DISABLED',
    );
    expectCode(
      await captureError(
        drafts.createOutreachDrafts(batch(1, { routingMode: 'explicit', mailboxId: 'mb-stale' })),
      ),
      'AUTH_REQUIRED',
    );
  });

  it('sends every draft to the named mailbox in explicit mode', async () => {
    const { store, state } = createFakeStore([
      mailbox({ id: 'mb-a', routingPriority: 1 }),
      mailbox({ id: 'mb-b', routingPriority: 2 }),
    ]);
    const adapters = createAdapters();
    const result = await service(store, adapters.factory).createOutreachDrafts(
      batch(3, { routingMode: 'explicit', mailboxId: 'mb-b' }),
    );

    expect(result.summary).toMatchObject({ requested: 3, created: 3, duplicates: 0, failed: 0 });
    expect(result.summary.byMailbox).toEqual({ 'mb-b': 3 });
    expect(adapters.calls['mb-a']).toBeUndefined();
    expect(state.usage).toEqual({ 'mb-b': 3 });
  });
});

describe('idempotency and deduplication', () => {
  it('returns the existing draft as a duplicate without calling the provider', async () => {
    const key = outreachIdempotencyKey('campaign-1', 'P1@Example.com', 1);
    const { store, state } = createFakeStore([mailbox({ id: 'mb-a' })], {
      drafts: [
        {
          id: 'draft-existing',
          idempotencyKey: key,
          mailboxId: 'mb-a',
          provider: 'gmail',
          status: 'created',
          providerDraftId: 'gmail-1',
          providerWebUrl: 'https://mail.example/1',
          campaignId: 'campaign-1',
          normalizedRecipientEmail: 'p1@example.com',
          sequenceStep: 1,
        },
      ],
    });
    const adapters = createAdapters();
    const result = await service(store, adapters.factory).createOutreachDrafts(batch(1));

    expect(result.results[0]).toMatchObject({
      internalDraftId: 'draft-existing',
      status: 'duplicate',
      duplicatePrevented: true,
      providerDraftId: 'gmail-1',
    });
    expect(adapters.calls['mb-a']).toBeUndefined();
    expect(state.usage).toEqual({});
  });

  it('treats a row still in status creating as an in-flight duplicate', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })], {
      drafts: [
        {
          id: 'draft-inflight',
          idempotencyKey: outreachIdempotencyKey('campaign-1', 'p1@example.com', 1),
          mailboxId: 'mb-a',
          provider: 'gmail',
          status: 'creating',
          campaignId: 'campaign-1',
          normalizedRecipientEmail: 'p1@example.com',
          sequenceStep: 1,
        },
      ],
    });
    const adapters = createAdapters();
    const result = await service(store, adapters.factory).createOutreachDrafts(batch(1));

    expect(result.results[0]).toMatchObject({
      internalDraftId: 'draft-inflight',
      status: 'duplicate',
      duplicatePrevented: true,
    });
    expect(result.results[0]?.providerDraftId).toBeUndefined();
    expect(adapters.calls['mb-a']).toBeUndefined();
  });

  it('loses the unique-constraint race gracefully and reports the winner as duplicate', async () => {
    const { store, state } = createFakeStore([mailbox({ id: 'mb-a' })]);
    state.raceOnce = {
      id: 'draft-winner',
      idempotencyKey: outreachIdempotencyKey('campaign-1', 'p1@example.com', 1),
      mailboxId: 'mb-a',
      provider: 'gmail',
      status: 'created',
      providerDraftId: 'gmail-winner',
      campaignId: 'campaign-1',
      normalizedRecipientEmail: 'p1@example.com',
      sequenceStep: 1,
    };
    const adapters = createAdapters();
    const result = await service(store, adapters.factory).createOutreachDrafts(batch(1));

    expect(result.results[0]).toMatchObject({
      internalDraftId: 'draft-winner',
      status: 'duplicate',
      duplicatePrevented: true,
      providerDraftId: 'gmail-winner',
    });
    // The loser never reaches the provider: no adapter was even constructed.
    expect(adapters.calls['mb-a']).toBeUndefined();
  });

  it('deduplicates two identical recipients inside the same batch', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters();
    const result = await service(store, adapters.factory).createOutreachDrafts(
      batch(0, { drafts: [entry('p1@example.com'), entry('P1@EXAMPLE.COM')] }),
    );

    expect(result.summary).toMatchObject({ created: 1, duplicates: 1, failed: 0 });
    expect(adapters.calls['mb-a']?.create).toHaveLength(1);
  });
});

describe('distributed routing', () => {
  it('round-robins deterministically in routing-priority order', async () => {
    const { store, state } = createFakeStore([
      mailbox({ id: 'mb-c', routingPriority: 3 }),
      mailbox({ id: 'mb-a', routingPriority: 1 }),
      mailbox({ id: 'mb-b', routingPriority: 2 }),
    ]);
    const adapters = createAdapters();
    const result = await service(store, adapters.factory).createOutreachDrafts(batch(8));

    expect(result.results.map((item) => item.mailboxId)).toEqual([
      'mb-a',
      'mb-b',
      'mb-c',
      'mb-a',
      'mb-b',
      'mb-c',
      'mb-a',
      'mb-b',
    ]);
    expect(result.summary.byMailbox).toEqual({ 'mb-a': 3, 'mb-b': 3, 'mb-c': 2 });
    expect(state.assignments).toHaveLength(8);
    expect(state.references).toHaveLength(8);
  });

  it('keeps an already-assigned prospect on its mailbox instead of round-robin', async () => {
    const { store, state } = createFakeStore(
      [
        mailbox({ id: 'mb-a', routingPriority: 1 }),
        mailbox({ id: 'mb-b', routingPriority: 2 }),
        mailbox({ id: 'mb-c', routingPriority: 3 }),
      ],
      {
        assignments: [
          {
            campaignId: 'campaign-1',
            prospectId: 'prospect-2',
            normalizedRecipientEmail: 'p2@example.com',
            mailboxId: 'mb-c',
          },
        ],
      },
    );
    const result = await service(store, createAdapters().factory).createOutreachDrafts(
      batch(3, { sequenceStep: 2 }),
    );

    expect(result.results.map((item) => item.mailboxId)).toEqual(['mb-a', 'mb-c', 'mb-b']);
    // The pre-existing assignment is never rewritten to another mailbox.
    expect(
      state.assignments.find((item) => item.normalizedRecipientEmail === 'p2@example.com'),
    ).toMatchObject({ mailboxId: 'mb-c', prospectId: 'prospect-2' });
  });

  it('fails a sticky prospect rather than moving it when its mailbox is unusable', async () => {
    const { store } = createFakeStore(
      [mailbox({ id: 'mb-a' }), mailbox({ id: 'mb-b', connectionStatus: 'revoked' })],
      {
        assignments: [
          {
            campaignId: 'campaign-1',
            prospectId: 'prospect-1',
            normalizedRecipientEmail: 'p1@example.com',
            mailboxId: 'mb-b',
          },
        ],
      },
    );
    const result = await service(store, createAdapters().factory).createOutreachDrafts(batch(1));

    expect(result.results[0]).toMatchObject({
      status: 'failed',
      errorCode: 'AUTH_REQUIRED',
      mailboxId: 'mb-b',
    });
  });
});

describe('limits', () => {
  it('caps each mailbox at its per-run limit and fails the overflow', async () => {
    const { store, state } = createFakeStore([mailbox({ id: 'mb-a', perRunDraftLimit: 5 })]);
    const adapters = createAdapters();
    const result = await service(store, adapters.factory).createOutreachDrafts(batch(8));

    expect(result.summary).toMatchObject({ requested: 8, created: 5, failed: 3 });
    expect(
      result.results.filter((item) => item.status === 'failed').map((item) => item.errorCode),
    ).toEqual(['PER_RUN_LIMIT_REACHED', 'PER_RUN_LIMIT_REACHED', 'PER_RUN_LIMIT_REACHED']);
    expect(adapters.calls['mb-a']?.create).toHaveLength(5);
    expect(state.usage).toEqual({ 'mb-a': 5 });
  });

  it('skips a mailbox that reached its daily limit and reports DAILY_LIMIT_REACHED when none is left', async () => {
    const { store } = createFakeStore(
      [
        mailbox({ id: 'mb-a', routingPriority: 1, dailyDraftLimit: 25 }),
        mailbox({ id: 'mb-b', routingPriority: 2, dailyDraftLimit: 25 }),
      ],
      { usage: { 'mb-a': 25 } },
    );
    const skipped = await service(store, createAdapters().factory).createOutreachDrafts(batch(2));
    expect(skipped.summary.byMailbox).toEqual({ 'mb-b': 2 });

    const { store: exhaustedStore } = createFakeStore(
      [mailbox({ id: 'mb-a', dailyDraftLimit: 25 }), mailbox({ id: 'mb-b', dailyDraftLimit: 25 })],
      { usage: { 'mb-a': 25, 'mb-b': 25 } },
    );
    const exhausted = await service(exhaustedStore, createAdapters().factory).createOutreachDrafts(
      batch(1),
    );
    expect(exhausted.results[0]).toMatchObject({
      status: 'failed',
      errorCode: 'DAILY_LIMIT_REACHED',
    });
  });
});

describe('batch time budget', () => {
  /** Every provider createDraft call takes `costMs` of the fake clock. */
  function slowProvider(costMs: number) {
    const adapters = createAdapters();
    let elapsedMs = 0;
    const factory: DraftAdapterFactory = (target, correlationId) => {
      const adapter = adapters.factory(target, correlationId);
      if (adapter === undefined) return undefined;
      return {
        ...adapter,
        createDraft(input) {
          elapsedMs += costMs;
          return adapter.createDraft(input);
        },
      };
    };
    const now = () => new Date(Date.parse(CLOCK) + elapsedMs);
    return { adapters, factory, now };
  }

  it('fails the entries the budget can no longer cover, before claiming a row', async () => {
    const { store, state } = createFakeStore([mailbox({ id: 'mb-a', perRunDraftLimit: 5 })]);
    const provider = slowProvider(15_000);
    const drafts = createDraftService({
      store,
      draftAdapterFactory: provider.factory,
      correlationId: CORRELATION_ID,
      now: provider.now,
    });

    // 45 s budget, 20 s provider timeout, 5 s margin: an entry starts only
    // while at most 20 s have passed. Entries 1 and 2 start at 0 s and 15 s;
    // entry 3 would start at 30 s.
    const result = await drafts.createOutreachDrafts(batch(5));

    expect(result.results.map((item) => item.status)).toEqual([
      'created',
      'created',
      'failed',
      'failed',
      'failed',
    ]);
    for (const failed of result.results.slice(2)) {
      expect(failed).toMatchObject({
        mailboxId: 'mb-a',
        errorCode: 'BATCH_TIME_BUDGET_EXCEEDED',
        errorMessage: BATCH_TIME_BUDGET_EXCEEDED_MESSAGE,
        duplicatePrevented: false,
      });
      expect(failed.internalDraftId).toBeUndefined();
    }
    expect(gatewayErrorRetryable('BATCH_TIME_BUDGET_EXCEEDED')).toBe(true);
    expect(result.summary).toMatchObject({ requested: 5, created: 2, failed: 3 });
    expect(provider.adapters.calls['mb-a']?.create).toHaveLength(2);
    // No row, operation or quota exists for the entries that never started.
    expect(state.drafts.map((draft) => draft.normalizedRecipientEmail)).toEqual([
      'p1@example.com',
      'p2@example.com',
    ]);
    expect(state.drafts.every((draft) => draft.status === 'created')).toBe(true);
    expect(state.operations).toHaveLength(2);
    expect(state.usage).toEqual({ 'mb-a': 2 });

    // Retrying the same batch finishes it: the created entries come back as
    // duplicates and the remaining ones are created.
    const retry = await createDraftService({
      store,
      draftAdapterFactory: provider.factory,
      correlationId: CORRELATION_ID,
      now: () => new Date(CLOCK),
    }).createOutreachDrafts(batch(5));
    expect(retry.results.map((item) => item.status)).toEqual([
      'duplicate',
      'duplicate',
      'created',
      'created',
      'created',
    ]);
  });

  it('starts nothing when the budget cannot cover one provider call, but still validates', async () => {
    const { store, state } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const provider = slowProvider(0);
    const tooShort = await createDraftService({
      store,
      draftAdapterFactory: provider.factory,
      correlationId: CORRELATION_ID,
      now: provider.now,
      batchDeadlineMs: DRAFT_PROVIDER_TIMEOUT_MS + BATCH_DEADLINE_MARGIN_MS - 1,
    }).createOutreachDrafts(batch(0, { drafts: [entry('not-an-email'), entry('p1@example.com')] }));

    expect(tooShort.results[0]).toMatchObject({ errorCode: 'INVALID_RECIPIENT' });
    expect(tooShort.results[1]).toMatchObject({ errorCode: 'BATCH_TIME_BUDGET_EXCEEDED' });
    expect(state.drafts).toEqual([]);
    expect(provider.adapters.calls['mb-a']).toBeUndefined();

    const justEnough = await createDraftService({
      store,
      draftAdapterFactory: provider.factory,
      correlationId: CORRELATION_ID,
      now: provider.now,
      batchDeadlineMs: DRAFT_PROVIDER_TIMEOUT_MS + BATCH_DEADLINE_MARGIN_MS,
    }).createOutreachDrafts(batch(1));
    expect(justEnough.results[0]).toMatchObject({ status: 'created' });
  });

  /** Every call of `method` takes `costMs` of the fake clock. */
  function slowMethod(
    adapters: FakeAdapters,
    method: 'getDraftByMessageId' | 'deleteDraft',
    costMs: number,
  ) {
    let elapsedMs = 0;
    const factory: DraftAdapterFactory = (target, correlationId) => {
      const adapter = adapters.factory(target, correlationId);
      if (adapter === undefined) return undefined;
      const original = adapter[method].bind(adapter) as (id: string) => Promise<never>;
      return {
        ...adapter,
        [method]: (id: string) => {
          elapsedMs += costMs;
          return original(id);
        },
      };
    };
    const now = () => new Date(Date.parse(CLOCK) + elapsedMs);
    return { factory, now };
  }

  const budgetExceeded = {
    status: 'failed',
    errorCode: 'BATCH_TIME_BUDGET_EXCEEDED',
    errorMessage: BATCH_TIME_BUDGET_EXCEEDED_MESSAGE,
  };

  it('adopts only the drafts the budget covers, claiming nothing for the rest', async () => {
    const { store, state } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters();
    const provider = slowMethod(adapters, 'getDraftByMessageId', 15_000);

    // Same arithmetic as the create batch: items start at 0 s and 15 s, the
    // third would start at 30 s with only 15 s of the 45 s budget left.
    const result = await createDraftService({
      store,
      draftAdapterFactory: provider.factory,
      correlationId: CORRELATION_ID,
      now: provider.now,
    }).adoptExternalDrafts({
      mailboxId: 'mb-a',
      providerMessageIds: ['m1', 'm2', 'm3', 'm4'],
    });

    expect(result.results.map((item) => item.status)).toEqual([
      'adopted',
      'adopted',
      'failed',
      'failed',
    ]);
    expect(result.results.slice(2)).toEqual([
      { index: 2, providerMessageId: 'm3', ...budgetExceeded },
      { index: 3, providerMessageId: 'm4', ...budgetExceeded },
    ]);
    expect(result.summary).toEqual({ requested: 4, adopted: 2, alreadyManaged: 0, failed: 2 });
    expect(adapters.calls['mb-a']?.getByMessage).toEqual(['m1', 'm2']);
    // No claimed row is left behind for the items that never started.
    expect(state.drafts).toHaveLength(2);
    expect(state.drafts.every((draft) => draft.status === 'created')).toBe(true);
  });

  it('deletes only the drafts the budget covers and keeps the rest', async () => {
    const { store, state } = createFakeStore([mailbox({ id: 'mb-a', perRunDraftLimit: 5 })]);
    const adapters = createAdapters();
    const created = await service(store, adapters.factory).createOutreachDrafts(batch(4));
    const ids = created.results.map((item) => item.internalDraftId ?? '');
    const provider = slowMethod(adapters, 'deleteDraft', 15_000);

    const result = await createDraftService({
      store,
      draftAdapterFactory: provider.factory,
      correlationId: CORRELATION_ID,
      now: provider.now,
    }).deleteOutreachDrafts({ internalDraftIds: ids });

    expect(result.results.map((item) => item.status)).toEqual([
      'deleted',
      'deleted',
      'failed',
      'failed',
    ]);
    expect(result.results.slice(2)).toEqual([
      { index: 2, internalDraftId: ids[2], ...budgetExceeded },
      { index: 3, internalDraftId: ids[3], ...budgetExceeded },
    ]);
    expect(result.summary).toEqual({ requested: 4, deleted: 2, failed: 2 });
    expect(adapters.calls['mb-a']?.remove).toHaveLength(2);
    expect(state.drafts.map((draft) => draft.status)).toEqual([
      'deleted',
      'deleted',
      'created',
      'created',
    ]);
  });
});

describe('provider failures', () => {
  it('marks the failed row and still completes the rest of the batch', async () => {
    const { store, state } = createFakeStore([
      mailbox({ id: 'mb-a', routingPriority: 1 }),
      mailbox({ id: 'mb-b', routingPriority: 2 }),
    ]);
    const adapters = createAdapters({
      'mb-a': {
        fail: new GatewayError('PROVIDER_UNAVAILABLE', 'Gmail is down', {
          retryable: true,
          correlationId: CORRELATION_ID,
        }),
      },
    });
    const result = await service(store, adapters.factory).createOutreachDrafts(batch(2));

    expect(result.summary).toMatchObject({ requested: 2, created: 1, failed: 1 });
    expect(result.results[0]).toMatchObject({
      mailboxId: 'mb-a',
      status: 'failed',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
    expect(result.results[1]).toMatchObject({ mailboxId: 'mb-b', status: 'created' });
    expect(state.drafts[0]).toMatchObject({
      status: 'failed',
      lastErrorCode: 'PROVIDER_UNAVAILABLE',
    });
    expect(state.operations).toEqual([
      expect.objectContaining({
        operation: 'create',
        status: 'failed',
        errorCode: 'PROVIDER_UNAVAILABLE',
      }),
      expect.objectContaining({ operation: 'create', status: 'succeeded' }),
    ]);
    expect(state.usage).toEqual({ 'mb-b': 1 });
  });

  it('reports UNSUPPORTED_OPERATION when no draft adapter is wired', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const result = await service(store, () => undefined).createOutreachDrafts(batch(1));
    expect(result.results[0]).toMatchObject({
      status: 'failed',
      errorCode: 'UNSUPPORTED_OPERATION',
    });
  });

  it('rejects a malformed recipient per draft without failing the batch', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const result = await service(store, createAdapters().factory).createOutreachDrafts(
      batch(0, { drafts: [entry('not-an-email'), entry('p1@example.com')] }),
    );
    expect(result.results[0]).toMatchObject({ status: 'failed', errorCode: 'INVALID_RECIPIENT' });
    expect(result.results[1]).toMatchObject({ status: 'created' });
  });
});

describe('createReplyDraft', () => {
  it('creates the reply in the source mailbox and cannot be redirected', async () => {
    const { store, state } = createFakeStore([
      mailbox({ id: 'mb-a', routingPriority: 1 }),
      mailbox({ id: 'mb-b', routingPriority: 2 }),
    ]);
    const adapters = createAdapters();
    const result = await service(store, adapters.factory).createReplyDraft({
      mailboxId: 'mb-b',
      sourceMessageId: 'message-9',
      replyMode: 'replyAll',
      textBody: 'Thanks!',
    });

    expect(result).toMatchObject({
      mailboxId: 'mb-b',
      status: 'created',
      duplicatePrevented: false,
    });
    expect(adapters.calls['mb-a']).toBeUndefined();
    expect(adapters.calls['mb-b']?.reply).toEqual([
      {
        sourceMessageId: 'message-9',
        replyMode: 'replyAll',
        textBody: 'Thanks!',
        htmlBody: '<p style="margin:0 0 1em 0">Thanks!</p>',
        quoteOriginal: true,
      },
    ]);
    expect(state.drafts[0]).toMatchObject({
      mailboxId: 'mb-b',
      sourceMessageId: 'message-9',
      status: 'created',
    });
    expect(state.drafts[0]?.contentHash).toHaveLength(16);
    // Replies do not consume the outreach daily quota.
    expect(state.usage).toEqual({});
    expect(state.references).toHaveLength(1);
  });

  it('returns a duplicate for the same mailbox, message, mode and body', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters();
    const drafts = service(store, adapters.factory);
    const input = {
      mailboxId: 'mb-a',
      sourceMessageId: 'message-1',
      replyMode: 'reply' as const,
      textBody: 'Same body',
    };
    const first = await drafts.createReplyDraft(input);
    const second = await drafts.createReplyDraft(input);

    expect(replyIdempotencyKey(input)).toMatch(/^mb-a:message-1:reply:[0-9a-f]{16}$/);
    expect(second).toMatchObject({
      internalDraftId: first.internalDraftId,
      status: 'duplicate',
      duplicatePrevented: true,
    });
    expect(adapters.calls['mb-a']?.reply).toHaveLength(1);
  });

  it('refuses an unknown or disconnected source mailbox', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a', connectionStatus: 'expired' })]);
    const drafts = service(store, createAdapters().factory);
    expectCode(
      await captureError(
        drafts.createReplyDraft({
          mailboxId: 'ghost',
          sourceMessageId: 'm1',
          replyMode: 'reply',
          textBody: 'x',
        }),
      ),
      'MAILBOX_NOT_FOUND',
    );
    expectCode(
      await captureError(
        drafts.createReplyDraft({
          mailboxId: 'mb-a',
          sourceMessageId: 'm1',
          replyMode: 'reply',
          textBody: 'x',
        }),
      ),
      'AUTH_REQUIRED',
    );
  });
});

describe('update, delete, list and status', () => {
  async function seeded() {
    const fake = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters();
    const drafts = service(fake.store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));
    const internalDraftId = created.results[0]?.internalDraftId ?? '';
    return { ...fake, adapters, drafts, internalDraftId };
  }

  it('updates only drafts the gateway owns', async () => {
    const { drafts, adapters, internalDraftId, state } = await seeded();
    const summary = await drafts.updateOutreachDraft({
      internalDraftId,
      subject: 'Updated subject',
      to: 'new@example.com',
    });

    expect(summary.status).toBe('updated');
    expect(adapters.calls['mb-a']?.update).toEqual([
      {
        providerDraftId: 'mb-a-draft-1',
        update: { subject: 'Updated subject', to: ['new@example.com'] },
      },
    ]);
    // The dedup identity keeps the original recipient so the unique index holds.
    expect(state.drafts[0]?.normalizedRecipientEmail).toBe('p1@example.com');
    expectCode(
      await captureError(drafts.updateOutreachDraft({ internalDraftId: 'nope', subject: 'x' })),
      'DRAFT_NOT_FOUND',
    );
    expectCode(
      await captureError(drafts.updateOutreachDraft({ internalDraftId })),
      'INVALID_QUERY',
    );
    expectCode(
      await captureError(drafts.updateOutreachDraft({ internalDraftId, to: 'nope' })),
      'INVALID_RECIPIENT',
    );
  });

  it('uses only a registered mailbox alias as the From identity', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a', aliases: ['alex@example.com'] })]);
    const adapters = createAdapters();
    const drafts = service(store, adapters.factory);

    await drafts.createOutreachDrafts(
      batch(1, {
        routingMode: 'explicit',
        mailboxId: 'mb-a',
        fromAddress: 'Alex@Example.com',
      }),
    );
    expect(adapters.calls['mb-a']?.create[0]?.from).toBe('alex@example.com');

    expectCode(
      await captureError(
        drafts.createOutreachDrafts(
          batch(1, {
            routingMode: 'explicit',
            mailboxId: 'mb-a',
            fromAddress: 'intruder@example.com',
          }),
        ),
      ),
      'INVALID_QUERY',
    );
  });

  it('deletes only drafts the gateway owns and never twice', async () => {
    const { drafts, adapters, internalDraftId } = await seeded();
    expectCode(
      await captureError(drafts.deleteOutreachDraft({ internalDraftId: 'provider-draft-id' })),
      'DRAFT_NOT_FOUND',
    );

    const summary = await drafts.deleteOutreachDraft({ internalDraftId });
    expect(summary.status).toBe('deleted');
    expect(adapters.calls['mb-a']?.remove).toEqual(['mb-a-draft-1']);

    expectCode(
      await captureError(drafts.deleteOutreachDraft({ internalDraftId })),
      'DRAFT_NOT_FOUND',
    );
  });

  it('records an already-missing provider draft as an idempotent deletion', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters({
      'mb-a': {
        deleteFail: new GatewayError('DRAFT_NOT_FOUND', 'already gone', {
          retryable: false,
          correlationId: CORRELATION_ID,
        }),
      },
    });
    const drafts = service(store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));

    const deleted = await drafts.deleteOutreachDraft({
      internalDraftId: created.results[0]?.internalDraftId ?? '',
    });
    expect(deleted.status).toBe('deleted');
  });

  it('lists campaign drafts and filters by status', async () => {
    const { drafts, internalDraftId } = await seeded();
    expect(await drafts.listCampaignDrafts({ campaignId: 'campaign-1' })).toHaveLength(1);
    expect(
      await drafts.listCampaignDrafts({ campaignId: 'campaign-1', status: 'deleted' }),
    ).toEqual([]);
    expect(
      (await drafts.listCampaignDrafts({ campaignId: 'campaign-1' }))[0]?.internalDraftId,
    ).toBe(internalDraftId);
  });

  it('checks the provider for liveness and turns a 404 into stillExists false', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters({
      'mb-a': {
        getDraftFail: new GatewayError('DRAFT_NOT_FOUND', 'gone', {
          retryable: false,
          correlationId: CORRELATION_ID,
        }),
      },
    });
    const drafts = service(store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));
    const internalDraftId = created.results[0]?.internalDraftId ?? '';

    const status = await drafts.getDraftStatus({ internalDraftId });
    expect(status).toMatchObject({
      stillExists: false,
      providerCheckErrorCode: 'DRAFT_NOT_FOUND',
      status: 'created',
    });
    expectCode(
      await captureError(drafts.getDraftStatus({ internalDraftId: 'nope' })),
      'DRAFT_NOT_FOUND',
    );
  });

  it('stays optimistic when the liveness check itself fails', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const failing = createAdapters({
      'mb-a': {
        getDraftFail: new GatewayError('PROVIDER_TIMEOUT', 'slow', {
          retryable: true,
          correlationId: CORRELATION_ID,
        }),
      },
    });
    const drafts = service(store, failing.factory);
    const created = await drafts.createOutreachDrafts(batch(1));
    const status = await drafts.getDraftStatus({
      internalDraftId: created.results[0]?.internalDraftId ?? '',
    });
    expect(status).toMatchObject({ stillExists: true, providerCheckErrorCode: 'PROVIDER_TIMEOUT' });
  });
});

describe('autonomous draft delivery', () => {
  async function seeded(behaviour: Record<string, AdapterBehaviour> = {}) {
    const fake = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters(behaviour);
    const drafts = service(fake.store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));
    return {
      ...fake,
      adapters,
      drafts,
      internalDraftId: created.results[0]?.internalDraftId ?? '',
    };
  }

  it('sends a gateway draft once and treats a repeated call as idempotent success', async () => {
    const { drafts, adapters, internalDraftId, state } = await seeded();
    const first = await drafts.sendDraft({ internalDraftId });
    const second = await drafts.sendDraft({ internalDraftId });

    expect(first).toMatchObject({
      status: 'sent',
      alreadySent: false,
      providerSentMessageId: 'mb-a-draft-1-sent',
    });
    expect(second).toMatchObject({ status: 'sent', alreadySent: true });
    expect(adapters.calls['mb-a']?.send).toEqual(['mb-a-draft-1']);
    await expect(drafts.getDraftStatus({ internalDraftId })).resolves.toMatchObject({
      status: 'sent',
      stillExists: false,
    });
    expect(adapters.calls['mb-a']?.get).toEqual([]);
    expect(state.sentUsage).toEqual({ 'mb-a': 1 });
    expect(state.references[0]).toMatchObject({
      providerMessageId: 'mb-a-draft-1-sent',
      threadId: 'mb-a-thread-1',
      internetMessageId: '<mb-a-draft-1-sent@example.com>',
    });
    expect(state.operations).toContainEqual(
      expect.objectContaining({ operation: 'send', status: 'succeeded' }),
    );
  });

  it('delivers reply drafts through the same managed-draft path', async () => {
    const fake = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters();
    const drafts = service(fake.store, adapters.factory);
    const reply = await drafts.createReplyDraft({
      mailboxId: 'mb-a',
      sourceMessageId: 'source-message-1',
      replyMode: 'reply',
      textBody: 'Thanks for the reply',
    });

    await expect(
      drafts.sendDraft({ internalDraftId: reply.internalDraftId ?? '' }),
    ).resolves.toMatchObject({ status: 'sent', alreadySent: false });
    expect(adapters.calls['mb-a']?.send).toEqual(['mb-a-draft-1']);
  });

  it('enforces the independent daily send limit before contacting the provider', async () => {
    const fake = createFakeStore([mailbox({ id: 'mb-a', dailySendLimit: 1 })], {
      sentUsage: { 'mb-a': 1 },
    });
    const adapters = createAdapters();
    const drafts = service(fake.store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));

    expectCode(
      await captureError(
        drafts.sendDraft({ internalDraftId: created.results[0]?.internalDraftId ?? '' }),
      ),
      'DAILY_LIMIT_REACHED',
    );
    expect(adapters.calls['mb-a']?.send).toEqual([]);
  });

  it('enforces alias limits independently while preserving primary-address capacity', async () => {
    const primary = 'hello@example.com';
    const alias = 'alex@example.com';
    const fake = createFakeStore(
      [
        mailbox({
          id: 'mb-a',
          emailAddress: primary,
          aliases: [alias],
          dailySendLimit: 55,
          dailySendLimitsByIdentity: { [primary]: 40, [alias]: 15 },
        }),
      ],
      {
        sentUsage: { 'mb-a': 15 },
        sentUsageByIdentity: { [`mb-a:${alias}`]: 15 },
      },
    );
    const adapters = createAdapters();
    const drafts = service(fake.store, adapters.factory);
    const aliasDraft = await drafts.createOutreachDrafts(
      batch(1, {
        campaignId: 'alias-campaign',
        routingMode: 'explicit',
        mailboxId: 'mb-a',
        fromAddress: alias,
      }),
    );
    const primaryDraft = await drafts.createOutreachDrafts(
      batch(1, {
        campaignId: 'primary-campaign',
        routingMode: 'explicit',
        mailboxId: 'mb-a',
        fromAddress: primary,
      }),
    );

    expectCode(
      await captureError(
        drafts.sendDraft({ internalDraftId: aliasDraft.results[0]?.internalDraftId ?? '' }),
      ),
      'DAILY_LIMIT_REACHED',
    );
    await expect(
      drafts.sendDraft({ internalDraftId: primaryDraft.results[0]?.internalDraftId ?? '' }),
    ).resolves.toMatchObject({ status: 'sent', alreadySent: false });
    expect(adapters.calls['mb-a']?.send).toEqual([primaryDraft.results[0]?.providerDraftId]);
    expect(fake.state.sentUsage).toEqual({ 'mb-a': 16 });
    expect(fake.state.sentUsageByIdentity).toEqual({
      [`mb-a:${alias}`]: 15,
      [`mb-a:${primary}`]: 1,
    });
  });

  it('restores a draft and its quota after a definitive provider rejection', async () => {
    const failure = new GatewayError('TOKEN_EXPIRED', 'Reconnect', {
      retryable: false,
      correlationId: CORRELATION_ID,
    });
    const { drafts, internalDraftId, state } = await seeded({ 'mb-a': { sendFail: failure } });

    expectCode(await captureError(drafts.sendDraft({ internalDraftId })), 'TOKEN_EXPIRED');
    expect(state.drafts[0]).toMatchObject({ status: 'created', lastErrorCode: 'TOKEN_EXPIRED' });
    expect(state.sentUsage).toEqual({ 'mb-a': 0 });
  });

  it('blocks retries when a timeout leaves provider acceptance uncertain', async () => {
    const failure = new GatewayError('PROVIDER_TIMEOUT', 'Timed out after submit', {
      retryable: true,
      correlationId: CORRELATION_ID,
    });
    const { drafts, adapters, internalDraftId, state } = await seeded({
      'mb-a': { sendFail: failure },
    });

    const claimed = await captureError(drafts.sendDraft({ internalDraftId }));
    const blocked = await captureError(drafts.sendDraft({ internalDraftId }));
    expectCode(claimed, 'SEND_STATUS_UNKNOWN');
    expectCode(blocked, 'SEND_STATUS_UNKNOWN');
    // A blocked send must name the only way out, not just refuse, and must
    // carry the provider's own words: the tool layer never exposes `cause`.
    expect(claimed.message).toContain('reconcile_draft_send');
    expect(claimed.message).toContain('PROVIDER_TIMEOUT: Timed out after submit');
    expect(blocked.message).toContain('reconcile_draft_send');
    expect(state.drafts[0]).toMatchObject({
      status: 'send_unknown',
      lastErrorCode: 'SEND_STATUS_UNKNOWN',
    });
    expect(state.sentUsage).toEqual({ 'mb-a': 1 });
    expect(adapters.calls['mb-a']?.send).toHaveLength(1);
  });

  it('fails closed when the provider throws an unclassified error', async () => {
    const { drafts, internalDraftId, state } = await seeded({
      'mb-a': { sendFail: new Error('unexpected transport failure') },
    });

    expectCode(await captureError(drafts.sendDraft({ internalDraftId })), 'SEND_STATUS_UNKNOWN');
    expect(state.drafts[0]).toMatchObject({
      status: 'send_unknown',
      lastErrorCode: 'SEND_STATUS_UNKNOWN',
    });
    expect(state.sentUsage).toEqual({ 'mb-a': 1 });
  });

  it('fails closed if persistence breaks after provider acceptance', async () => {
    const { store, drafts, internalDraftId, state, adapters } = await seeded();
    store.finalizeDraftSend = () =>
      Promise.reject(
        new GatewayError('DATABASE_ERROR', 'commit failed', {
          retryable: true,
          correlationId: CORRELATION_ID,
        }),
      );

    expectCode(await captureError(drafts.sendDraft({ internalDraftId })), 'SEND_STATUS_UNKNOWN');
    expect(state.drafts[0]).toMatchObject({
      status: 'send_unknown',
      lastErrorCode: 'SEND_STATUS_UNKNOWN',
    });
    expect(adapters.calls['mb-a']?.send).toHaveLength(1);
    expect(state.sentUsage).toEqual({ 'mb-a': 1 });
  });
});

describe('reconciling an uncertain send', () => {
  const AMBIGUOUS = new GatewayError('PROVIDER_TIMEOUT', 'Timed out after submit', {
    retryable: true,
    correlationId: CORRELATION_ID,
  });
  const RECIPIENT = 'p1@example.com';

  function sentCopy(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
    return {
      mailboxId: 'mb-a',
      provider: 'gmail',
      messageId: 'sent-message-1',
      threadId: 'sent-thread-1',
      internetMessageId: '<sent-message-1@example.com>',
      replyTo: [],
      to: [{ address: RECIPIENT }],
      cc: [],
      subject: '  HELLO  ',
      sentAt: CLOCK,
      isRead: true,
      isDraft: false,
      hasAttachments: false,
      folderIds: [],
      labelIds: [],
      references: [],
      ...overrides,
    };
  }

  /** Drives one draft into `send_unknown` through an ambiguous provider timeout. */
  async function stuck(
    provider: DraftMailboxRecord['provider'],
    behaviour: AdapterBehaviour = {},
    reconciledAt: Date = new Date(CLOCK),
  ) {
    const fake = createFakeStore([mailbox({ id: 'mb-a', provider })]);
    const adapters = createAdapters({ 'mb-a': { ...behaviour, sendFail: AMBIGUOUS } });
    const sender = service(fake.store, adapters.factory);
    const created = await sender.createOutreachDrafts(batch(1));
    const internalDraftId = created.results[0]?.internalDraftId ?? '';
    expectCode(await captureError(sender.sendDraft({ internalDraftId })), 'SEND_STATUS_UNKNOWN');
    return {
      ...fake,
      adapters,
      internalDraftId,
      drafts: service(fake.store, adapters.factory, () => reconciledAt),
    };
  }

  it('settles a Gmail draft still sitting in Drafts as not sent and gives the quota back', async () => {
    const { drafts, state, adapters, internalDraftId } = await stuck('gmail');

    await expect(drafts.reconcileDraftSend({ internalDraftId })).resolves.toMatchObject({
      outcome: 'not_sent',
      status: 'created',
      evidence: { draftStillPresent: true, sentMatchFound: false },
    });
    expect(state.drafts[0]).toMatchObject({
      status: 'created',
      // The reason the send became uncertain survives the repair.
      lastErrorCode: 'SEND_STATUS_UNKNOWN',
    });
    expect(state.sentUsage).toEqual({ 'mb-a': 0 });
    expect(adapters.calls['mb-a']?.search[0]).toMatchObject({
      folder: 'sent',
      to: RECIPIENT,
      subject: 'Hello',
    });
    expect(state.operations).toContainEqual(
      expect.objectContaining({ operation: 'reconcile', status: 'succeeded' }),
    );
  });

  it('accepts a Sent copy as proof of delivery whatever the provider', async () => {
    const { drafts, state, internalDraftId } = await stuck('zoho', {
      sentMessages: [sentCopy()],
    });

    await expect(drafts.reconcileDraftSend({ internalDraftId })).resolves.toMatchObject({
      outcome: 'sent',
      status: 'sent',
      providerSentMessageId: 'sent-message-1',
      evidence: { sentMatchFound: true },
    });
    // A delivered message keeps the quota it consumed.
    expect(state.sentUsage).toEqual({ 'mb-a': 1 });
  });

  it('ignores a Sent message that predates the claim', async () => {
    const { drafts, internalDraftId } = await stuck('gmail', {
      sentMessages: [sentCopy({ sentAt: '2026-08-06T09:00:00.000Z' })],
    });

    await expect(drafts.reconcileDraftSend({ internalDraftId })).resolves.toMatchObject({
      outcome: 'not_sent',
      evidence: { sentMatchFound: false },
    });
  });

  it('leaves a fresh Zoho row unresolved because its draft survives a send', async () => {
    const { drafts, state, internalDraftId } = await stuck('zoho');

    const result = await drafts.reconcileDraftSend({ internalDraftId });
    expect(result).toMatchObject({
      outcome: 'unresolved',
      status: 'send_unknown',
      evidence: { draftStillPresent: true, sentMatchFound: false },
    });
    expect(result.reason).toContain('Zoho');
    expect(state.drafts[0]).toMatchObject({ status: 'send_unknown' });
    expect(state.sentUsage).toEqual({ 'mb-a': 1 });
    expect(state.operations).toContainEqual(
      expect.objectContaining({ operation: 'reconcile', status: 'failed' }),
    );
  });

  it('settles an aged Zoho row with an empty Sent folder as not sent', async () => {
    const { drafts, state, internalDraftId } = await stuck(
      'zoho',
      {},
      new Date('2026-08-07T09:06:00.000Z'),
    );

    await expect(drafts.reconcileDraftSend({ internalDraftId })).resolves.toMatchObject({
      outcome: 'not_sent',
      status: 'created',
    });
    expect(state.sentUsage).toEqual({ 'mb-a': 0 });
  });

  it('reports an unsearchable Sent folder instead of guessing', async () => {
    const failure = new GatewayError('PROVIDER_RATE_LIMIT', 'Slow down', {
      retryable: true,
      correlationId: CORRELATION_ID,
    });
    const { drafts, state, internalDraftId } = await stuck('gmail', { searchFail: failure });

    const result = await drafts.reconcileDraftSend({ internalDraftId });
    expect(result).toMatchObject({ outcome: 'unresolved', status: 'send_unknown' });
    expect(result.reason).toContain('PROVIDER_RATE_LIMIT');
    expect(state.drafts[0]).toMatchObject({
      status: 'send_unknown',
      lastErrorCode: 'SEND_STATUS_UNKNOWN',
    });
    expect(state.sentUsage).toEqual({ 'mb-a': 1 });
  });

  it('refuses a row that is not awaiting reconciliation', async () => {
    const fake = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters();
    const drafts = service(fake.store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));

    expectCode(
      await captureError(
        drafts.reconcileDraftSend({
          internalDraftId: created.results[0]?.internalDraftId ?? '',
        }),
      ),
      'INVALID_QUERY',
    );
    expect(adapters.calls['mb-a']?.search).toEqual([]);
  });

  it('answers a settled row from the ledger without contacting the provider', async () => {
    const fake = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters();
    const drafts = service(fake.store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));
    const internalDraftId = created.results[0]?.internalDraftId ?? '';
    await drafts.sendDraft({ internalDraftId });

    await expect(drafts.reconcileDraftSend({ internalDraftId })).resolves.toMatchObject({
      outcome: 'sent',
      status: 'sent',
    });
    expect(adapters.calls['mb-a']?.search).toEqual([]);
    expect(adapters.calls['mb-a']?.get).toEqual([]);
  });

  it('admits a sending claim only once it is older than two provider timeouts', async () => {
    const fake = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters({ 'mb-a': { sendFail: AMBIGUOUS } });
    const drafts = service(fake.store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));
    const internalDraftId = created.results[0]?.internalDraftId ?? '';
    const row = fake.state.drafts[0];
    if (row === undefined) throw new Error('missing seeded draft');
    // A process that died between the claim and the provider answer.
    row.status = 'sending';
    row.updatedAt = CLOCK;

    const fresh = service(fake.store, adapters.factory, () => new Date('2026-08-07T09:00:39.000Z'));
    expectCode(await captureError(fresh.reconcileDraftSend({ internalDraftId })), 'INVALID_QUERY');

    const fresherStatus = await fresh.getDraftStatus({ internalDraftId });
    expect(fresherStatus.reconciliationHint).toBeUndefined();

    const stale = service(fake.store, adapters.factory, () => new Date('2026-08-07T09:00:41.000Z'));
    await expect(stale.reconcileDraftSend({ internalDraftId })).resolves.toMatchObject({
      outcome: 'not_sent',
      status: 'created',
    });
  });

  it('points get_draft_status at the repair path while the outcome is unknown', async () => {
    const { drafts, internalDraftId } = await stuck('gmail');

    const status = await drafts.getDraftStatus({ internalDraftId });
    expect(status.status).toBe('send_unknown');
    expect(status.reconciliationHint).toContain('reconcile_draft_send');
  });
});

describe('legacy draft adoption and batch cleanup', () => {
  it('adopts provider drafts once, then deletes the managed drafts in one batch', async () => {
    const { store, state } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters({
      'mb-a': {
        snapshot: {
          providerDraftId: 'stable-provider-draft',
          subject: 'Legacy draft',
          to: ['prospect@example.com'],
        },
      },
    });
    const drafts = service(store, adapters.factory);

    const first = await drafts.adoptExternalDrafts({
      mailboxId: 'mb-a',
      providerMessageIds: ['legacy-message'],
      campaignId: 'legacy-campaign',
    });
    const second = await drafts.adoptExternalDrafts({
      mailboxId: 'mb-a',
      providerMessageIds: ['legacy-message'],
      campaignId: 'legacy-campaign',
    });

    expect(first.summary).toEqual({ requested: 1, adopted: 1, alreadyManaged: 0, failed: 0 });
    expect(second.summary).toEqual({ requested: 1, adopted: 0, alreadyManaged: 1, failed: 0 });
    expect(first.results[0]?.draft).toMatchObject({
      campaignId: 'legacy-campaign',
      providerDraftId: 'stable-provider-draft',
      providerMessageId: 'legacy-message',
      status: 'created',
    });
    expect(state.usage).toEqual({});
    expect(state.operations.map((operation) => operation.operation)).toEqual(['adopt']);

    const internalDraftId = first.results[0]?.draft?.internalDraftId ?? '';
    const deleted = await drafts.deleteOutreachDrafts({
      internalDraftIds: [internalDraftId, 'not-managed'],
    });
    expect(deleted.summary).toEqual({ requested: 2, deleted: 1, failed: 1 });
    expect(deleted.results.map((result) => result.status)).toEqual(['deleted', 'failed']);
    expect(adapters.calls['mb-a']?.remove).toEqual(['stable-provider-draft']);
  });

  it('returns a per-item failure when a message is not a live provider draft', async () => {
    const { store } = createFakeStore([mailbox({ id: 'mb-a' })]);
    const adapters = createAdapters({
      'mb-a': {
        getDraftFail: new GatewayError('DRAFT_NOT_FOUND', 'not a draft', {
          retryable: false,
          correlationId: CORRELATION_ID,
        }),
      },
    });

    const result = await service(store, adapters.factory).adoptExternalDrafts({
      mailboxId: 'mb-a',
      providerMessageIds: ['sent-message'],
    });
    expect(result.results).toEqual([
      {
        index: 0,
        providerMessageId: 'sent-message',
        status: 'failed',
        errorCode: 'DRAFT_NOT_FOUND',
      },
    ]);
  });
});

describe('provider rejections are certain send outcomes', () => {
  it('restores the draft and releases the quota when the provider refuses the send', async () => {
    const fake = createFakeStore([mailbox({ id: 'mb-a' })]);
    const failure = new GatewayError(
      'PROVIDER_REJECTED',
      'Zoho Mail refused the request (HTTP 404, URL_RULE_NOT_CONFIGURED, Invalid Input)',
      { retryable: false, correlationId: CORRELATION_ID },
    );
    const adapters = createAdapters({ 'mb-a': { sendFail: failure } });
    const drafts = service(fake.store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));
    const internalDraftId = created.results[0]?.internalDraftId ?? '';

    const error = await captureError(drafts.sendDraft({ internalDraftId }));

    expectCode(error, 'PROVIDER_REJECTED');
    expect(error.message).toBe(failure.message);
    expect(fake.state.drafts[0]).toMatchObject({
      status: 'created',
      lastErrorCode: 'PROVIDER_REJECTED',
    });
    expect(fake.state.sentUsage).toEqual({ 'mb-a': 0 });
    expect(fake.state.operations).toContainEqual(
      expect.objectContaining({
        operation: 'send',
        status: 'failed',
        errorCode: 'PROVIDER_REJECTED',
      }),
    );
  });
});

describe('delivery scope drift', () => {
  // The grant both Outlook mailboxes carry in production: consented before the
  // gateway started requesting Mail.Send, so reads work and delivery cannot.
  const FROZEN_OUTLOOK_GRANT = ['openid', 'profile', 'email', 'Mail.ReadWrite'];

  async function seededOutlook(grantedScopes: string[]) {
    const fake = createFakeStore([
      mailbox({ id: 'mb-outlook', provider: 'microsoft', grantedScopes }),
    ]);
    const adapters = createAdapters();
    const drafts = service(fake.store, adapters.factory);
    const created = await drafts.createOutreachDrafts(batch(1));
    return {
      ...fake,
      adapters,
      drafts,
      internalDraftId: created.results[0]?.internalDraftId ?? '',
    };
  }

  it('refuses a send whose grant misses a delivery scope, before claiming quota', async () => {
    const { store, drafts, adapters, internalDraftId, state } =
      await seededOutlook(FROZEN_OUTLOOK_GRANT);
    let claims = 0;
    const claimDraftForSending = store.claimDraftForSending.bind(store);
    store.claimDraftForSending = (internalId, usageDate, at) => {
      claims += 1;
      return claimDraftForSending(internalId, usageDate, at);
    };

    const error = await captureError(drafts.sendDraft({ internalDraftId }));

    expectCode(error, 'AUTH_REQUIRED');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('mb-outlook');
    expect(error.message).toContain('https://graph.microsoft.com/Mail.Send');
    expect(error.message).toContain('/oauth/microsoft/start');
    expect(claims).toBe(0);
    expect(adapters.calls['mb-outlook']?.send).toEqual([]);
    expect(state.sentUsage).toEqual({});
    expect(state.drafts[0]).toMatchObject({ status: 'created' });
  });

  it('sends once the grant carries Mail.Send, whatever spelling the provider echoed', async () => {
    const { drafts, internalDraftId } = await seededOutlook([...FROZEN_OUTLOOK_GRANT, 'Mail.Send']);

    await expect(drafts.sendDraft({ internalDraftId })).resolves.toMatchObject({ status: 'sent' });
  });
});

/** In-memory signature rows keyed by mailbox and identity; `fail` simulates an outage. */
function createFakeSignatureStore(
  rows: Array<Omit<StoredSignature, 'source' | 'updatedAt'>> = [],
): {
  store: SignatureStore;
  rows: StoredSignature[];
  lookups: string[];
  /** `next` fails every lookup from now on; `onLookup` fails only the n-th (1-based). */
  fail: { next: boolean; onLookup?: number };
} {
  const stored: StoredSignature[] = rows.map((row) => ({
    ...row,
    identityEmail: row.identityEmail.toLowerCase(),
    source: 'manual',
    updatedAt: CLOCK,
  }));
  const lookups: string[] = [];
  const fail: { next: boolean; onLookup?: number } = { next: false };
  const store: SignatureStore = {
    getSignature(mailboxId, identityEmail) {
      lookups.push(`${mailboxId}:${identityEmail}`);
      if (fail.next || fail.onLookup === lookups.length) {
        return Promise.reject(new Error('connection terminated'));
      }
      return Promise.resolve(
        stored.find(
          (row) => row.mailboxId === mailboxId && row.identityEmail === identityEmail.toLowerCase(),
        ),
      );
    },
    listSignatures: () => Promise.resolve(stored),
    upsertSignature: () => Promise.reject(new Error('not used')),
    deleteSignature: () => Promise.resolve(),
    applySignatureToAllIdentities: () => Promise.reject(new Error('not used')),
  };
  return { store, rows: stored, lookups, fail };
}

describe('draft bodies, signatures and quoted replies', () => {
  const SIGNATURES = [
    {
      mailboxId: 'mb-a',
      identityEmail: 'mb-a@example.com',
      displayName: 'Sam Taylor',
      signatureHtml: '<div><strong>Sam Taylor</strong><br>Example Ltd</div>',
      signatureText: 'Sam Taylor\nExample Ltd',
    },
    {
      mailboxId: 'mb-a',
      identityEmail: 'alex@example.com',
      displayName: 'Alex (Example Ltd)',
      signatureHtml: '<div>Alias signature</div>',
    },
  ];

  function signedService(
    options: {
      mailboxes?: DraftMailboxRecord[];
      signatures?: typeof SIGNATURES;
      drafts?: DraftRecord[];
      adapters?: Record<string, AdapterBehaviour>;
    } = {},
  ) {
    const fake = createFakeStore(
      options.mailboxes ?? [mailbox({ id: 'mb-a', aliases: ['alex@example.com'] })],
      { drafts: options.drafts ?? [] },
    );
    const signatures = createFakeSignatureStore(options.signatures ?? SIGNATURES);
    const adapters = createAdapters(options.adapters);
    const drafts = createDraftService({
      store: fake.store,
      draftAdapterFactory: adapters.factory,
      correlationId: CORRELATION_ID,
      signatureStore: signatures.store,
      quoteTimeZone: 'Europe/Rome',
      now: () => new Date(CLOCK),
    });
    return { ...fake, adapters, drafts, signatures };
  }

  it('renders a Markdown body to both parts and appends the identity signature', async () => {
    const { drafts, adapters } = signedService();
    const result = await drafts.createOutreachDrafts({
      campaignId: 'campaign-1',
      routingMode: 'distributed',
      drafts: [
        entry('p1@example.com', {
          textBody: undefined,
          body: 'Hi Marco,\n\nfirst paragraph with **bold** text.\n\nTalk soon',
        }),
      ],
    });

    expect(result.summary.created).toBe(1);
    const [created] = adapters.calls['mb-a']?.create ?? [];
    expect(created?.htmlBody?.match(/<p\b/gu)).toHaveLength(3);
    expect(created?.htmlBody).toContain('<strong>bold</strong>');
    expect(created?.htmlBody).toContain('class="gmail_signature"');
    expect(created?.textBody).toBe(
      'Hi Marco,\n\nfirst paragraph with bold text.\n\nTalk soon\n\n-- \nSam Taylor\nExample Ltd',
    );
    // The display name only travels with an explicit From, so the implicit
    // primary identity is made explicit.
    expect(created).toMatchObject({
      from: 'mb-a@example.com',
      fromDisplayName: 'Sam Taylor',
    });
  });

  it('skips the signature on request but keeps the display name', async () => {
    const { drafts, adapters } = signedService();
    await drafts.createOutreachDrafts({
      campaignId: 'campaign-1',
      routingMode: 'distributed',
      includeSignature: false,
      drafts: [entry('p1@example.com', { textBody: 'Body only' })],
    });

    const [created] = adapters.calls['mb-a']?.create ?? [];
    expect(created?.textBody).toBe('Body only');
    expect(created?.textBody).not.toContain('-- ');
    expect(created?.htmlBody).not.toContain('gmail_signature');
    expect(created?.fromDisplayName).toBe('Sam Taylor');
  });

  it('leaves the From header alone for an identity without a stored row', async () => {
    const { drafts, adapters } = signedService({ signatures: [] });
    await drafts.createOutreachDrafts(batch(1));

    const [created] = adapters.calls['mb-a']?.create ?? [];
    expect(created).toEqual({
      to: ['p1@example.com'],
      subject: 'Hello',
      textBody: 'Body',
      htmlBody: '<p style="margin:0 0 1em 0">Body</p>',
    });
  });

  it('signs a draft for the alias it is sent from', async () => {
    const { drafts, adapters } = signedService();
    await drafts.createOutreachDrafts(
      batch(1, { routingMode: 'explicit', mailboxId: 'mb-a', fromAddress: 'alex@example.com' }),
    );

    const [created] = adapters.calls['mb-a']?.create ?? [];
    expect(created).toMatchObject({
      from: 'alex@example.com',
      fromDisplayName: 'Alex (Example Ltd)',
    });
    expect(created?.htmlBody).toContain('Alias signature');
    expect(created?.textBody).toBe('Body\n\n-- \nAlias signature');
  });

  it('accepts textBody and htmlBody together, keeping the caller text as the text part', async () => {
    const { drafts, adapters, state } = signedService();
    await drafts.createOutreachDrafts({
      campaignId: 'campaign-1',
      routingMode: 'distributed',
      drafts: [
        entry('p1@example.com', {
          textBody: 'Hi Marco,\r\nline two',
          htmlBody: '<p>Hi <strong>Marco</strong>,<br>line two</p>',
        }),
      ],
    });

    const [created] = adapters.calls['mb-a']?.create ?? [];
    expect(created?.textBody).toBe('Hi Marco,\nline two\n\n-- \nSam Taylor\nExample Ltd');
    expect(created?.htmlBody).toContain('<strong>Marco</strong>');
    expect(created?.htmlBody).toContain('class="gmail_signature"');

    const reply = {
      mailboxId: 'mb-a',
      sourceMessageId: 'message-3',
      replyMode: 'reply' as const,
      textBody: 'Thanks',
      htmlBody: '<p>Thanks</p>',
    };
    await drafts.createReplyDraft(reply);
    const [replyCall] = adapters.calls['mb-a']?.reply ?? [];
    expect(replyCall).toMatchObject({ quoteOriginal: true });
    expect(replyCall?.textBody).toBe('Thanks\n\n-- \nSam Taylor\nExample Ltd');
    // Same key as before Markdown bodies: the text part wins, as `textBody ?? htmlBody` did.
    expect(replyIdempotencyKey(reply)).toBe(`mb-a:message-3:reply:${contentHash('\0Thanks')}`);
    expect(state.drafts.at(-1)?.contentHash).toBe(contentHash('Thanks'));
  });

  it('requires a body and keeps the Markdown body exclusive', async () => {
    const { drafts, adapters, state } = signedService();
    const result = await drafts.createOutreachDrafts({
      campaignId: 'campaign-1',
      routingMode: 'distributed',
      drafts: [
        entry('p1@example.com', { textBody: undefined }),
        entry('p2@example.com', { textBody: '   ', htmlBody: '' }),
        entry('p3@example.com', { body: 'Markdown', textBody: 'Text' }),
        entry('p4@example.com', { textBody: undefined, body: 'Markdown', htmlBody: '<p>Html</p>' }),
      ],
    });

    expect(result.results.map((item) => item.errorCode)).toEqual([
      'INVALID_QUERY',
      'INVALID_QUERY',
      'INVALID_QUERY',
      'INVALID_QUERY',
    ]);
    expect(adapters.calls['mb-a']).toBeUndefined();
    expect(state.drafts).toEqual([]);

    expectCode(
      await captureError(
        drafts.createReplyDraft({ mailboxId: 'mb-a', sourceMessageId: 'm1', replyMode: 'reply' }),
      ),
      'INVALID_QUERY',
    );
    expectCode(
      await captureError(
        drafts.createReplyDraft({
          mailboxId: 'mb-a',
          sourceMessageId: 'm1',
          replyMode: 'reply',
          body: 'One',
          htmlBody: '<p>Two</p>',
        }),
      ),
      'INVALID_QUERY',
    );
  });

  it('keeps reply idempotency on the raw body whatever the signature becomes', async () => {
    const { drafts, adapters, signatures, state } = signedService();
    const input = {
      mailboxId: 'mb-a',
      sourceMessageId: 'message-1',
      replyMode: 'reply' as const,
      body: 'Thanks, talk on **Thursday**.',
    };
    const first = await drafts.createReplyDraft(input);
    const original = signatures.rows[0];
    if (original !== undefined) original.signatureText = 'A different signature';
    const second = await drafts.createReplyDraft(input);

    expect(second).toMatchObject({
      internalDraftId: first.internalDraftId,
      status: 'duplicate',
      duplicatePrevented: true,
    });
    expect(adapters.calls['mb-a']?.reply).toHaveLength(1);
    expect(state.drafts[0]?.contentHash).toBe(contentHash(input.body));
    // Text and HTML bodies hash exactly as they did before Markdown existed.
    expect(
      replyIdempotencyKey({
        mailboxId: 'mb-a',
        sourceMessageId: 'message-1',
        replyMode: 'reply',
        textBody: 'Same body',
      }),
    ).toBe(`mb-a:message-1:reply:${contentHash('\0Same body')}`);
  });

  it('asks the adapter to quote the original below a signed reply', async () => {
    const { drafts, adapters } = signedService();
    await drafts.createReplyDraft({
      mailboxId: 'mb-a',
      sourceMessageId: 'message-7',
      replyMode: 'reply',
      body: 'Happy to.',
    });

    const [reply] = adapters.calls['mb-a']?.reply ?? [];
    expect(reply).toMatchObject({
      sourceMessageId: 'message-7',
      from: 'mb-a@example.com',
      fromDisplayName: 'Sam Taylor',
      quoteOriginal: true,
      quoteTimeZone: 'Europe/Rome',
    });
    expect(reply?.textBody).toBe('Happy to.\n\n-- \nSam Taylor\nExample Ltd');
    expect(reply?.htmlBody).toContain('gmail_signature');
  });

  it('re-quotes the original when the body of a reply draft is replaced', async () => {
    const { drafts, adapters } = signedService();
    const reply = await drafts.createReplyDraft({
      mailboxId: 'mb-a',
      sourceMessageId: 'message-7',
      replyMode: 'reply',
      fromAddress: 'alex@example.com',
      body: 'Prima versione',
    });
    await drafts.updateOutreachDraft({
      internalDraftId: reply.internalDraftId ?? '',
      body: 'Seconda versione',
    });

    const [update] = adapters.calls['mb-a']?.update ?? [];
    expect(update?.update).toMatchObject({
      quoteOriginalMessageId: 'message-7',
      quoteTimeZone: 'Europe/Rome',
      // Re-signed for the identity the draft already sends from.
      from: 'alex@example.com',
      fromDisplayName: 'Alex (Example Ltd)',
    });
    expect(update?.update.textBody).toBe('Seconda versione\n\n-- \nAlias signature');
  });

  it('reports a rebuilt quote only when the adapter could not keep the original one', async () => {
    const kept = signedService();
    const rebuilt = signedService({
      adapters: { 'mb-a': { updateSnapshot: { quoteRebuilt: true } } },
    });
    const results = [];
    for (const { drafts } of [kept, rebuilt]) {
      const reply = await drafts.createReplyDraft({
        mailboxId: 'mb-a',
        sourceMessageId: 'message-7',
        replyMode: 'reply',
        body: 'Prima versione',
      });
      results.push(
        await drafts.updateOutreachDraft({
          internalDraftId: reply.internalDraftId ?? '',
          body: 'Seconda versione',
        }),
      );
    }

    expect(results[0]).not.toHaveProperty('quoteRebuilt');
    expect(results[1]).toMatchObject({ status: 'updated', quoteRebuilt: true });
  });

  it('re-renders an outreach body without quoting and keeps header-only updates untouched', async () => {
    const { drafts, adapters } = signedService();
    const created = await drafts.createOutreachDrafts(batch(1));
    const internalDraftId = created.results[0]?.internalDraftId ?? '';

    await drafts.updateOutreachDraft({
      internalDraftId,
      body: 'New text',
      includeSignature: false,
    });
    await drafts.updateOutreachDraft({ internalDraftId, subject: 'Subject only' });
    await drafts.updateOutreachDraft({ internalDraftId, fromAddress: 'alex@example.com' });

    const updates = (adapters.calls['mb-a']?.update ?? []).map((call) => call.update);
    expect(updates[0]).toEqual({
      from: 'mb-a@example.com',
      fromDisplayName: 'Sam Taylor',
      textBody: 'New text',
      htmlBody: '<p style="margin:0 0 1em 0">New text</p>',
    });
    expect(updates[1]).toEqual({ subject: 'Subject only' });
    expect(updates[2]).toEqual({
      from: 'alex@example.com',
      fromDisplayName: 'Alex (Example Ltd)',
    });
    expectCode(
      await captureError(
        drafts.updateOutreachDraft({ internalDraftId, body: 'One', textBody: 'Two' }),
      ),
      'INVALID_QUERY',
    );
  });

  it('surfaces a signature lookup failure instead of creating an unsigned draft', async () => {
    const { drafts, adapters, signatures, state } = signedService();
    signatures.fail.next = true;
    const reply = {
      mailboxId: 'mb-a',
      sourceMessageId: 'message-1',
      replyMode: 'reply' as const,
      body: 'Hi',
    };

    expectCode(await captureError(drafts.createReplyDraft(reply)), 'DATABASE_ERROR');
    const outreach = await drafts.createOutreachDrafts(batch(1));
    expect(outreach.results).toMatchObject([
      { status: 'failed', errorCode: 'DATABASE_ERROR', mailboxId: 'mb-a' },
    ]);
    expect(adapters.calls['mb-a']).toBeUndefined();
    // The reply claimed its key before composing: the row is released as
    // failed, the way an adapter failure leaves it. The outreach entry composes
    // before its claim and leaves no row at all.
    expect(state.drafts).toMatchObject([{ status: 'failed', lastErrorCode: 'DATABASE_ERROR' }]);
    expect(state.drafts).toHaveLength(1);

    signatures.fail.next = false;
    const retried = await drafts.createReplyDraft(reply);
    expect(retried).toMatchObject({ status: 'created', internalDraftId: state.drafts[0]?.id });
  });

  it('fails only the batch entry whose signature lookup fails', async () => {
    const { drafts, adapters, signatures, state } = signedService();
    signatures.fail.onLookup = 2;

    const result = await drafts.createOutreachDrafts(batch(2));

    expect(result.results).toMatchObject([
      { index: 0, recipient: 'p1@example.com', status: 'created', mailboxId: 'mb-a' },
      {
        index: 1,
        recipient: 'p2@example.com',
        status: 'failed',
        errorCode: 'DATABASE_ERROR',
        mailboxId: 'mb-a',
      },
    ]);
    expect(result.summary).toMatchObject({ created: 1, failed: 1, byMailbox: { 'mb-a': 1 } });
    expect(adapters.calls['mb-a']?.create).toHaveLength(1);
    // No `creating` row is left behind for the failed entry.
    expect(state.drafts.map((draft) => [draft.normalizedRecipientEmail, draft.status])).toEqual([
      ['p1@example.com', 'created'],
    ]);
  });

  it('answers a repeated reply as a duplicate without reading the signature registry', async () => {
    const { drafts, adapters, signatures } = signedService();
    const reply = {
      mailboxId: 'mb-a',
      sourceMessageId: 'message-9',
      replyMode: 'reply' as const,
      body: 'Talk on Thursday.',
    };

    const first = await drafts.createReplyDraft(reply);
    signatures.fail.next = true;
    const second = await drafts.createReplyDraft(reply);

    expect(first.status).toBe('created');
    expect(second).toMatchObject({
      status: 'duplicate',
      duplicatePrevented: true,
      internalDraftId: first.internalDraftId,
    });
    expect(signatures.lookups).toHaveLength(1);
    expect(adapters.calls['mb-a']?.reply).toHaveLength(1);
  });

  it('refuses to re-sign a body for an alias the mailbox no longer has', async () => {
    const mailboxes = [mailbox({ id: 'mb-a', aliases: ['alex@example.com'] })];
    const { drafts, adapters, state } = signedService({ mailboxes });
    const created = await drafts.createOutreachDrafts(
      batch(1, { routingMode: 'explicit', mailboxId: 'mb-a', fromAddress: 'alex@example.com' }),
    );
    const internalDraftId = created.results[0]?.internalDraftId ?? '';
    mailboxes[0] = mailbox({ id: 'mb-a', aliases: [] });

    const error = await captureError(
      drafts.updateOutreachDraft({ internalDraftId, body: 'New text' }),
    );
    expectCode(error, 'INVALID_QUERY');
    expect(error.message).toContain('alex@example.com');
    expect(error.message).toContain('fromAddress');
    expect(adapters.calls['mb-a']?.update ?? []).toHaveLength(0);
    expect(state.drafts[0]?.sendingIdentityEmail).toBe('alex@example.com');

    // An explicit identity settles it: body, From and the stored row move together.
    await drafts.updateOutreachDraft({
      internalDraftId,
      body: 'New text',
      fromAddress: 'mb-a@example.com',
    });
    expect(adapters.calls['mb-a']?.update?.[0]?.update).toMatchObject({
      from: 'mb-a@example.com',
      fromDisplayName: 'Sam Taylor',
    });
    expect(state.drafts[0]?.sendingIdentityEmail).toBe('mb-a@example.com');
  });
});
