import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../packages/core/src/index.js';
import type {
  MailProviderAdapter,
  NormalizedEmail,
  NormalizedSearchQuery,
  PaginatedResult,
} from '../../packages/core/src/index.js';
import type { AdapterFactory, MailboxRecord } from '../../apps/mcp-server/src/mail-search.js';
import {
  DEFAULT_REPLY_WINDOW_DAYS,
  findOutreachReplies,
  isOwnMessage,
  matchReply,
  normalizeReplySubject,
  type ListOutreachRepliesInput,
  type ReferenceRecord,
  type ReplyMatchingStore,
} from '../../apps/mcp-server/src/reply-matching.js';

const CORRELATION_ID = '3f1c2d64-5f9a-4a2b-9c1e-0a7b8d5e6f10';
const NOW = new Date('2026-08-07T10:00:00.000Z');
const REFERENCE_AT = new Date('2026-08-01T09:00:00.000Z');

function mailbox(overrides: Partial<MailboxRecord> & { id: string }): MailboxRecord {
  return {
    provider: 'gmail',
    emailAddress: `${overrides.id}@example.com`,
    aliases: [],
    enabled: true,
    connectionStatus: 'connected',
    ...overrides,
  };
}

function reference(overrides: Partial<ReferenceRecord> & { id: string }): ReferenceRecord {
  return {
    mailboxId: 'a',
    campaignId: 'camp-1',
    providerMessageId: `provider-${overrides.id}`,
    createdAt: REFERENCE_AT,
    ...overrides,
  };
}

function email(
  overrides: Partial<NormalizedEmail> & { mailboxId: string; messageId: string },
): NormalizedEmail {
  return {
    provider: 'gmail' as const,
    replyTo: [],
    to: [],
    cc: [],
    subject: 'Subject',
    isRead: false,
    isDraft: false,
    hasAttachments: false,
    folderIds: [],
    labelIds: [],
    references: [],
    receivedAt: '2026-08-05T12:00:00.000Z',
    ...overrides,
  } satisfies NormalizedEmail;
}

interface StoreSpy extends ReplyMatchingStore {
  referenceCalls: (string | undefined)[];
}

function createStore(rows: MailboxRecord[], references: ReferenceRecord[]): StoreSpy {
  const referenceCalls: (string | undefined)[] = [];
  return {
    referenceCalls,
    listMailboxes: () => Promise.resolve(rows),
    listReferences: (campaignId) => {
      referenceCalls.push(campaignId);
      return Promise.resolve(
        campaignId === undefined
          ? references
          : references.filter((row) => row.campaignId === campaignId),
      );
    },
  };
}

interface FakeAdapterBehaviour {
  items?: NormalizedEmail[];
  fail?: Error;
  delayMs?: number;
  onSearch?: (query: NormalizedSearchQuery) => void;
}

function createAdapter(mailboxId: string, behaviour: FakeAdapterBehaviour): MailProviderAdapter {
  return {
    mailboxId,
    provider: 'gmail',
    verifyConnection: () => Promise.resolve({ status: 'ok' as const }),
    searchEmails: async (query) => {
      behaviour.onSearch?.(query);
      if (behaviour.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      }
      if (behaviour.fail !== undefined) throw behaviour.fail;
      const page: PaginatedResult<NormalizedEmail> = { items: behaviour.items ?? [] };
      return page;
    },
    getEmail: () => Promise.reject(new Error('not used')),
    getThread: () => Promise.reject(new Error('not used')),
  };
}

function factoryFor(adapters: Record<string, MailProviderAdapter | undefined>): AdapterFactory {
  return (target) => adapters[target.id];
}

function scan(options: {
  rows: MailboxRecord[];
  references: ReferenceRecord[];
  adapters: Record<string, MailProviderAdapter | undefined>;
  input?: ListOutreachRepliesInput;
  store?: StoreSpy;
  timeoutMs?: number;
}) {
  const store = options.store ?? createStore(options.rows, options.references);
  return findOutreachReplies({
    store,
    adapterFactory: factoryFor(options.adapters),
    correlationId: CORRELATION_ID,
    input: options.input ?? {},
    timeoutMs: options.timeoutMs ?? 50,
    now: () => NOW,
  });
}

describe('normalizeReplySubject', () => {
  it('ignores reply and forward prefixes, casing and spacing', () => {
    expect(normalizeReplySubject('Re: Quick   question')).toBe('quick question');
    expect(normalizeReplySubject('FWD: Quick question')).toBe('quick question');
    expect(normalizeReplySubject('RE: Re: Fw: Quick question')).toBe('quick question');
    expect(normalizeReplySubject('Quick question')).toBe('quick question');
  });

  it('keeps a subject that only looks like a prefix and drops empty ones', () => {
    expect(normalizeReplySubject('Report: numbers')).toBe('report: numbers');
    expect(normalizeReplySubject('   ')).toBeUndefined();
    expect(normalizeReplySubject(undefined)).toBeUndefined();
  });
});

describe('matchReply tiers', () => {
  it('matches a thread or conversation id with confidence 0.95', () => {
    const byThread = matchReply(email({ mailboxId: 'a', messageId: 'm1', threadId: 't-9' }), [
      reference({ id: 'r1', threadId: 't-9' }),
    ]);
    expect(byThread).toMatchObject({ matchMethod: 'thread', confidence: 0.95 });
    expect(byThread?.reference.id).toBe('r1');

    const byConversation = matchReply(
      email({ mailboxId: 'a', messageId: 'm1', conversationId: 'c-9' }),
      [reference({ id: 'r2', conversationId: 'c-9' })],
    );
    expect(byConversation).toMatchObject({ matchMethod: 'thread', confidence: 0.95 });
  });

  it('matches In-Reply-To against the reference message-id with confidence 0.9', () => {
    const match = matchReply(
      email({ mailboxId: 'a', messageId: 'm1', inReplyTo: '<OUT-1@example.com>' }),
      [reference({ id: 'r1', internetMessageId: 'out-1@example.com' })],
    );
    expect(match).toMatchObject({ matchMethod: 'inReplyTo', confidence: 0.9 });
    expect(match?.reference.id).toBe('r1');
  });

  it('matches the References chain with confidence 0.85', () => {
    const match = matchReply(
      email({
        mailboxId: 'a',
        messageId: 'm1',
        references: ['<root@example.com>', '<out-2@example.com>'],
      }),
      [reference({ id: 'r2', internetMessageId: '<out-2@example.com>' })],
    );
    expect(match).toMatchObject({ matchMethod: 'references', confidence: 0.85 });
    expect(match?.reference.id).toBe('r2');
  });

  it('matches an identical internet message-id with confidence 0.8', () => {
    const match = matchReply(
      email({ mailboxId: 'a', messageId: 'm1', internetMessageId: '<out-3@example.com>' }),
      [reference({ id: 'r3', internetMessageId: '<out-3@example.com>' })],
    );
    expect(match).toMatchObject({ matchMethod: 'messageId', confidence: 0.8 });
  });

  it('matches recipient plus subject plus time window with confidence 0.5', () => {
    const match = matchReply(
      email({
        mailboxId: 'a',
        messageId: 'm1',
        from: { address: 'Prospect@Example.com' },
        subject: 'Re: Quick question',
        receivedAt: '2026-08-03T12:00:00.000Z',
      }),
      [
        reference({
          id: 'r4',
          normalizedRecipient: 'prospect@example.com',
          subject: 'Quick question',
        }),
      ],
    );
    expect(match).toMatchObject({ matchMethod: 'recipientSubjectTime', confidence: 0.5 });
    expect(match?.reference.id).toBe('r4');
  });

  it('prefers the most reliable tier when several apply and never reports twice', () => {
    const candidate = email({
      mailboxId: 'a',
      messageId: 'm1',
      threadId: 't-9',
      inReplyTo: '<out-1@example.com>',
      references: ['<out-1@example.com>'],
      internetMessageId: '<out-1@example.com>',
      from: { address: 'prospect@example.com' },
      subject: 'Re: Quick question',
    });
    const references = [
      reference({ id: 'weak', internetMessageId: 'out-1@example.com' }),
      reference({ id: 'strong', threadId: 't-9' }),
    ];
    const match = matchReply(candidate, references);
    expect(match).toMatchObject({ matchMethod: 'thread', confidence: 0.95 });
    expect(match?.reference.id).toBe('strong');
  });

  it('rejects a candidate older than the reference and one with no signal at all', () => {
    const older = matchReply(
      email({
        mailboxId: 'a',
        messageId: 'm1',
        from: { address: 'prospect@example.com' },
        subject: 'Re: Quick question',
        receivedAt: '2026-07-30T12:00:00.000Z',
      }),
      [
        reference({
          id: 'r4',
          normalizedRecipient: 'prospect@example.com',
          subject: 'Quick question',
        }),
      ],
    );
    expect(older).toBeUndefined();

    expect(
      matchReply(email({ mailboxId: 'a', messageId: 'm1', subject: 'Unrelated' }), [
        reference({ id: 'r1', threadId: 't-9' }),
      ]),
    ).toBeUndefined();
    expect(
      matchReply(email({ mailboxId: 'a', messageId: 'm1', threadId: 't-9' }), []),
    ).toBeUndefined();
  });

  it('never matches a draft', () => {
    expect(
      matchReply(email({ mailboxId: 'a', messageId: 'm1', threadId: 't-9', isDraft: true }), [
        reference({ id: 'r1', threadId: 't-9' }),
      ]),
    ).toBeUndefined();
  });
});

describe('isOwnMessage', () => {
  it('flags drafts and messages sent from the mailbox itself', () => {
    expect(
      isOwnMessage(email({ mailboxId: 'a', messageId: 'm1', isDraft: true }), 'a@example.com'),
    ).toBe(true);
    expect(
      isOwnMessage(
        email({ mailboxId: 'a', messageId: 'm1', from: { address: 'A@Example.com' } }),
        'a@example.com',
      ),
    ).toBe(true);
    expect(
      isOwnMessage(
        email({ mailboxId: 'a', messageId: 'm1', from: { address: 'prospect@example.com' } }),
        'a@example.com',
      ),
    ).toBe(false);
  });
});

describe('findOutreachReplies', () => {
  it('returns the documented shape for a matched inbox message', async () => {
    const rows = [mailbox({ id: 'a' })];
    const result = await scan({
      rows,
      references: [
        reference({ id: 'r1', prospectId: 'prospect-7', threadId: 't-9', campaignId: 'camp-1' }),
      ],
      adapters: {
        a: createAdapter('a', {
          items: [
            email({
              mailboxId: 'a',
              messageId: 'inbox-1',
              threadId: 't-9',
              from: { name: 'Prospect', address: 'prospect@example.com' },
              subject: 'Re: Quick question',
              snippet: 'sounds interesting',
              receivedAt: '2026-08-05T12:00:00.000Z',
              isRead: false,
            }),
          ],
        }),
      },
    });

    expect(result.partialFailures).toEqual([]);
    expect(result.replies).toEqual([
      {
        campaignId: 'camp-1',
        prospectId: 'prospect-7',
        mailboxId: 'a',
        sourceMessageId: 'inbox-1',
        threadId: 't-9',
        from: 'prospect@example.com',
        subject: 'Re: Quick question',
        receivedAt: '2026-08-05T12:00:00.000Z',
        isUnread: true,
        snippet: 'sounds interesting',
        matchMethod: 'thread',
        confidence: 0.95,
      },
    ]);
  });

  it('scans the inbox with the default 14 day window and the requested unread filter', async () => {
    const rows = [mailbox({ id: 'a' })];
    const queries: NormalizedSearchQuery[] = [];
    await scan({
      rows,
      references: [reference({ id: 'r1', threadId: 't-9' })],
      input: { unreadOnly: true },
      adapters: {
        a: createAdapter('a', { items: [], onSearch: (query) => queries.push(query) }),
      },
    });

    const expectedSince = new Date(
      NOW.getTime() - DEFAULT_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(queries).toEqual([
      { folder: 'inbox', after: expectedSince, limit: 50, unreadOnly: true },
    ]);
  });

  it('never calls the adapter of a mailbox without outreach references', async () => {
    const rows = [mailbox({ id: 'a' }), mailbox({ id: 'b' })];
    let bCalls = 0;
    const result = await scan({
      rows,
      references: [reference({ id: 'r1', mailboxId: 'a', threadId: 't-9' })],
      adapters: {
        a: createAdapter('a', {
          items: [email({ mailboxId: 'a', messageId: 'inbox-1', threadId: 't-9' })],
        }),
        b: createAdapter('b', {
          onSearch: () => {
            bCalls += 1;
          },
          items: [],
        }),
      },
    });

    expect(bCalls).toBe(0);
    expect(result.replies.map((reply) => reply.mailboxId)).toEqual(['a']);
    expect(result.partialFailures).toEqual([]);
  });

  it('skips the gateway own drafts and messages sent from the mailbox address', async () => {
    const rows = [mailbox({ id: 'a', emailAddress: 'outreach@example.com' })];
    const result = await scan({
      rows,
      references: [reference({ id: 'r1', threadId: 't-9' })],
      adapters: {
        a: createAdapter('a', {
          items: [
            email({ mailboxId: 'a', messageId: 'own-draft', threadId: 't-9', isDraft: true }),
            email({
              mailboxId: 'a',
              messageId: 'own-sent',
              threadId: 't-9',
              from: { address: 'Outreach@Example.com' },
            }),
            email({
              mailboxId: 'a',
              messageId: 'real-reply',
              threadId: 't-9',
              from: { address: 'prospect@example.com' },
            }),
          ],
        }),
      },
    });

    expect(result.replies.map((reply) => reply.sourceMessageId)).toEqual(['real-reply']);
  });

  it('matches a "Re:" subject reply through the heuristic tier', async () => {
    const rows = [mailbox({ id: 'a' })];
    const result = await scan({
      rows,
      references: [
        reference({
          id: 'r1',
          normalizedRecipient: 'prospect@example.com',
          subject: 'Quick question',
        }),
      ],
      adapters: {
        a: createAdapter('a', {
          items: [
            email({
              mailboxId: 'a',
              messageId: 'inbox-1',
              from: { address: 'prospect@example.com' },
              subject: 'RE:  Quick question',
              receivedAt: '2026-08-04T12:00:00.000Z',
            }),
          ],
        }),
      },
    });

    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({
      matchMethod: 'recipientSubjectTime',
      confidence: 0.5,
      sourceMessageId: 'inbox-1',
    });
  });

  it('drops a candidate that predates the reference', async () => {
    const rows = [mailbox({ id: 'a' })];
    const result = await scan({
      rows,
      references: [
        reference({
          id: 'r1',
          normalizedRecipient: 'prospect@example.com',
          subject: 'Quick question',
        }),
      ],
      adapters: {
        a: createAdapter('a', {
          items: [
            email({
              mailboxId: 'a',
              messageId: 'too-old',
              from: { address: 'prospect@example.com' },
              subject: 'Re: Quick question',
              receivedAt: '2026-07-31T12:00:00.000Z',
            }),
          ],
        }),
      },
    });

    expect(result.replies).toEqual([]);
  });

  it.each([
    ['weak first', false],
    ['strong first', true],
  ])(
    'dedupes one message per mailbox keeping the highest confidence (%s)',
    async (_name, reverse) => {
      const rows = [mailbox({ id: 'a' })];
      const weak = email({
        mailboxId: 'a',
        messageId: 'inbox-1',
        from: { address: 'prospect@example.com' },
        subject: 'Re: Quick question',
        receivedAt: '2026-08-05T12:00:00.000Z',
      });
      const strong = { ...weak, threadId: 't-9' } satisfies NormalizedEmail;
      const items = reverse ? [strong, weak] : [weak, strong];

      const result = await scan({
        rows,
        references: [
          reference({ id: 'r-thread', threadId: 't-9' }),
          reference({
            id: 'r-heuristic',
            normalizedRecipient: 'prospect@example.com',
            subject: 'Quick question',
          }),
        ],
        adapters: { a: createAdapter('a', { items }) },
      });

      expect(result.replies).toHaveLength(1);
      expect(result.replies[0]).toMatchObject({
        sourceMessageId: 'inbox-1',
        matchMethod: 'thread',
        confidence: 0.95,
      });
    },
  );

  it('keeps other mailboxes usable when one fails and reports it in partialFailures', async () => {
    const rows = [
      mailbox({ id: 'ok' }),
      mailbox({ id: 'slow' }),
      mailbox({ id: 'boom' }),
      mailbox({ id: 'no-adapter' }),
      mailbox({ id: 'stale', connectionStatus: 'expired' }),
    ];
    const result = await scan({
      rows,
      timeoutMs: 20,
      references: [
        reference({ id: 'r1', mailboxId: 'ok', threadId: 't-ok' }),
        reference({ id: 'r2', mailboxId: 'slow', threadId: 't-slow' }),
        reference({ id: 'r3', mailboxId: 'boom', threadId: 't-boom' }),
        reference({ id: 'r4', mailboxId: 'no-adapter', threadId: 't-none' }),
      ],
      adapters: {
        ok: createAdapter('ok', {
          items: [email({ mailboxId: 'ok', messageId: 'inbox-ok', threadId: 't-ok' })],
        }),
        slow: createAdapter('slow', { delayMs: 200 }),
        boom: createAdapter('boom', {
          fail: new GatewayError('PROVIDER_RATE_LIMIT', 'slow down', {
            retryable: true,
            correlationId: CORRELATION_ID,
          }),
        }),
      },
    });

    expect(result.replies.map((reply) => reply.sourceMessageId)).toEqual(['inbox-ok']);
    expect(result.partialFailures).toEqual([
      { mailboxId: 'stale', errorCode: 'AUTH_REQUIRED' },
      { mailboxId: 'slow', errorCode: 'PROVIDER_TIMEOUT' },
      { mailboxId: 'boom', errorCode: 'PROVIDER_RATE_LIMIT' },
      { mailboxId: 'no-adapter', errorCode: 'UNSUPPORTED_OPERATION' },
    ]);
  });

  it('sorts newest first across mailboxes and applies the limit', async () => {
    const rows = [mailbox({ id: 'a' }), mailbox({ id: 'b' })];
    const result = await scan({
      rows,
      input: { limit: 2 },
      references: [
        reference({ id: 'r1', mailboxId: 'a', threadId: 't-a' }),
        reference({ id: 'r2', mailboxId: 'b', threadId: 't-b' }),
      ],
      adapters: {
        a: createAdapter('a', {
          items: [
            email({
              mailboxId: 'a',
              messageId: 'oldest',
              threadId: 't-a',
              receivedAt: '2026-08-02T12:00:00.000Z',
            }),
            email({
              mailboxId: 'a',
              messageId: 'newest',
              threadId: 't-a',
              receivedAt: '2026-08-06T12:00:00.000Z',
            }),
          ],
        }),
        b: createAdapter('b', {
          items: [
            email({
              mailboxId: 'b',
              messageId: 'middle',
              threadId: 't-b',
              receivedAt: '2026-08-04T12:00:00.000Z',
            }),
          ],
        }),
      },
    });

    expect(result.replies.map((reply) => reply.sourceMessageId)).toEqual(['newest', 'middle']);
  });

  it('passes the campaign filter to the store and scopes the result to it', async () => {
    const rows = [mailbox({ id: 'a' })];
    const store = createStore(rows, [
      reference({ id: 'r1', campaignId: 'camp-1', threadId: 't-1' }),
      reference({ id: 'r2', campaignId: 'camp-2', threadId: 't-2' }),
    ]);
    const result = await scan({
      rows,
      store,
      references: [],
      input: { campaignId: 'camp-2' },
      adapters: {
        a: createAdapter('a', {
          items: [
            email({ mailboxId: 'a', messageId: 'inbox-1', threadId: 't-1' }),
            email({ mailboxId: 'a', messageId: 'inbox-2', threadId: 't-2' }),
          ],
        }),
      },
    });

    expect(store.referenceCalls).toEqual(['camp-2']);
    expect(result.replies.map((reply) => reply.sourceMessageId)).toEqual(['inbox-2']);
    expect(result.replies[0]?.campaignId).toBe('camp-2');
  });

  it('asks the store for every campaign when none is requested', async () => {
    const rows = [mailbox({ id: 'a' })];
    const store = createStore(rows, [reference({ id: 'r1', threadId: 't-1' })]);
    await scan({ rows, store, references: [], adapters: { a: createAdapter('a', { items: [] }) } });
    expect(store.referenceCalls).toEqual([undefined]);
  });
});
