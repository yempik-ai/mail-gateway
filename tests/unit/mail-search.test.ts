import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../packages/core/src/index.js';
import type {
  MailProviderAdapter,
  NormalizedEmail,
  NormalizedSearchQuery,
  NormalizedThread,
  PaginatedResult,
} from '../../packages/core/src/index.js';
import {
  createMailSearchService,
  decodeSearchCursor,
  encodeSearchCursor,
  mergeSearchPages,
  resolveTargetMailboxes,
  searchAcrossMailboxes,
  toEmailSummary,
  type AdapterFactory,
  type MailboxRecord,
  type MailboxStore,
  type SearchEmailsInput,
} from '../../apps/mcp-server/src/mail-search.js';

const CORRELATION_ID = '3f1c2d64-5f9a-4a2b-9c1e-0a7b8d5e6f10';

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

function email(overrides: Partial<NormalizedEmail> & { mailboxId: string; messageId: string }) {
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
    ...overrides,
  } satisfies NormalizedEmail;
}

interface StoreSpy extends MailboxStore {
  readCalls: { mailboxIds: string[]; at: Date }[];
}

function createStore(rows: MailboxRecord[]): StoreSpy {
  const readCalls: { mailboxIds: string[]; at: Date }[] = [];
  return {
    readCalls,
    listMailboxes: () => Promise.resolve(rows),
    recordSuccessfulRead: (mailboxIds, at) => {
      readCalls.push({ mailboxIds, at });
      return Promise.resolve();
    },
  };
}

interface FakeAdapterBehaviour {
  items?: NormalizedEmail[];
  nextCursor?: string;
  fail?: Error;
  delayMs?: number;
  thread?: NormalizedThread;
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
      const page: PaginatedResult<NormalizedEmail> = {
        items: behaviour.items ?? [],
        ...(behaviour.nextCursor === undefined ? {} : { nextCursor: behaviour.nextCursor }),
      };
      return page;
    },
    getEmail: (messageId) => {
      if (behaviour.fail !== undefined) return Promise.reject(behaviour.fail);
      const found = (behaviour.items ?? []).find((item) => item.messageId === messageId);
      if (!found) return Promise.reject(new Error(`unknown message ${messageId}`));
      return Promise.resolve(found);
    },
    getThread: () => {
      if (behaviour.fail !== undefined) return Promise.reject(behaviour.fail);
      if (!behaviour.thread) return Promise.reject(new Error('no thread'));
      return Promise.resolve(behaviour.thread);
    },
  };
}

function factoryFor(adapters: Record<string, MailProviderAdapter | undefined>): AdapterFactory {
  return (target) => adapters[target.id];
}

function search(options: {
  rows: MailboxRecord[];
  adapters: Record<string, MailProviderAdapter | undefined>;
  input?: SearchEmailsInput;
  store?: StoreSpy;
  timeoutMs?: number;
}) {
  const store = options.store ?? createStore(options.rows);
  return searchAcrossMailboxes({
    store,
    adapterFactory: factoryFor(options.adapters),
    correlationId: CORRELATION_ID,
    input: options.input ?? {},
    timeoutMs: options.timeoutMs ?? 50,
    now: () => new Date('2026-08-07T10:00:00.000Z'),
  });
}

describe('mergeSearchPages', () => {
  it('sorts by receivedAt descending and pushes undated messages last', () => {
    const merged = mergeSearchPages(
      [
        [
          email({ mailboxId: 'a', messageId: 'old', receivedAt: '2026-08-01T00:00:00.000Z' }),
          email({ mailboxId: 'a', messageId: 'undated' }),
        ],
        [
          email({ mailboxId: 'b', messageId: 'new', receivedAt: '2026-08-05T00:00:00.000Z' }),
          email({ mailboxId: 'b', messageId: 'broken', receivedAt: 'not-a-date' }),
        ],
      ],
      10,
    );
    expect(merged.map((item) => item.messageId)).toEqual(['new', 'old', 'undated', 'broken']);
  });

  it('drops duplicates of the same mailbox and message but keeps cross-mailbox copies', () => {
    const merged = mergeSearchPages(
      [
        [email({ mailboxId: 'a', messageId: 'm1', receivedAt: '2026-08-05T00:00:00.000Z' })],
        [
          email({ mailboxId: 'a', messageId: 'm1', receivedAt: '2026-08-05T00:00:00.000Z' }),
          email({ mailboxId: 'b', messageId: 'm1', receivedAt: '2026-08-04T00:00:00.000Z' }),
        ],
      ],
      10,
    );
    expect(merged.map((item) => `${item.mailboxId}:${item.messageId}`)).toEqual(['a:m1', 'b:m1']);
  });

  it('applies the global limit after merging', () => {
    const pages = [
      [
        email({ mailboxId: 'a', messageId: 'a1', receivedAt: '2026-08-05T00:00:00.000Z' }),
        email({ mailboxId: 'a', messageId: 'a2', receivedAt: '2026-08-03T00:00:00.000Z' }),
      ],
      [
        email({ mailboxId: 'b', messageId: 'b1', receivedAt: '2026-08-04T00:00:00.000Z' }),
        email({ mailboxId: 'b', messageId: 'b2', receivedAt: '2026-08-02T00:00:00.000Z' }),
      ],
    ];
    expect(mergeSearchPages(pages, 3).map((item) => item.messageId)).toEqual(['a1', 'b1', 'a2']);
  });
});

describe('search cursor', () => {
  it('round-trips a per-mailbox cursor map', () => {
    const cursors = { 'primary-gmail': 'page-2', 'sales-outlook': 'skiptoken=42' };
    const encoded = encodeSearchCursor(cursors);
    expect(encoded).toBeDefined();
    expect(encoded).not.toContain('{');
    expect(decodeSearchCursor(encoded, CORRELATION_ID)).toEqual(cursors);
  });

  it('encodes nothing for an empty map and decodes a missing cursor to an empty map', () => {
    expect(encodeSearchCursor({})).toBeUndefined();
    expect(decodeSearchCursor(undefined, CORRELATION_ID)).toEqual({});
  });

  it('rejects a malformed cursor with INVALID_QUERY', () => {
    const notJson = Buffer.from('nope', 'utf8').toString('base64url');
    const notAMap = Buffer.from(JSON.stringify(['a']), 'utf8').toString('base64url');
    for (const cursor of [notJson, notAMap]) {
      expect(() => decodeSearchCursor(cursor, CORRELATION_ID)).toThrow(GatewayError);
      try {
        decodeSearchCursor(cursor, CORRELATION_ID);
      } catch (error) {
        expect((error as GatewayError).code).toBe('INVALID_QUERY');
      }
    }
  });
});

describe('resolveTargetMailboxes', () => {
  it('queries every enabled and connected mailbox when no ids are requested', () => {
    const { targets, failures } = resolveTargetMailboxes([
      mailbox({ id: 'a' }),
      mailbox({ id: 'b', enabled: false }),
      mailbox({ id: 'c', connectionStatus: 'expired' }),
    ]);
    expect(targets.map((row) => row.id)).toEqual(['a']);
    expect(failures).toEqual([{ mailboxId: 'c', errorCode: 'AUTH_REQUIRED' }]);
  });

  it('reports unknown, disabled and disconnected requested mailboxes', () => {
    const { targets, failures } = resolveTargetMailboxes(
      [mailbox({ id: 'a' }), mailbox({ id: 'b', enabled: false })],
      ['a', 'b', 'ghost', 'a'],
    );
    expect(targets.map((row) => row.id)).toEqual(['a']);
    expect(failures).toEqual([
      { mailboxId: 'b', errorCode: 'MAILBOX_DISABLED' },
      { mailboxId: 'ghost', errorCode: 'MAILBOX_NOT_FOUND' },
    ]);
  });
});

describe('searchAcrossMailboxes', () => {
  it('merges mailboxes, strips bodies and records the successful reads', async () => {
    const rows = [mailbox({ id: 'a' }), mailbox({ id: 'b' })];
    const store = createStore(rows);
    const result = await search({
      rows,
      store,
      adapters: {
        a: createAdapter('a', {
          items: [
            email({
              mailboxId: 'a',
              messageId: 'a1',
              receivedAt: '2026-08-01T00:00:00.000Z',
              snippet: 'visible snippet',
              textBody: 'secret text',
              htmlBody: '<p>secret html</p>',
            }),
          ],
        }),
        b: createAdapter('b', {
          items: [
            email({ mailboxId: 'b', messageId: 'b1', receivedAt: '2026-08-06T00:00:00.000Z' }),
          ],
        }),
      },
    });

    expect(result.emails.map((item) => item.messageId)).toEqual(['b1', 'a1']);
    expect(result.partialFailures).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
    const stripped = result.emails[1];
    expect(stripped).toBeDefined();
    expect(stripped).not.toHaveProperty('textBody');
    expect(stripped).not.toHaveProperty('htmlBody');
    expect(stripped?.snippet).toBe('visible snippet');
    expect(store.readCalls).toEqual([
      { mailboxIds: ['a', 'b'], at: new Date('2026-08-07T10:00:00.000Z') },
    ]);
  });

  it('turns a slow provider into a PROVIDER_TIMEOUT partial failure', async () => {
    const rows = [mailbox({ id: 'fast' }), mailbox({ id: 'slow' })];
    const store = createStore(rows);
    const result = await search({
      rows,
      store,
      timeoutMs: 20,
      adapters: {
        fast: createAdapter('fast', {
          items: [
            email({ mailboxId: 'fast', messageId: 'f1', receivedAt: '2026-08-06T00:00:00.000Z' }),
          ],
        }),
        slow: createAdapter('slow', { delayMs: 200 }),
      },
    });

    expect(result.emails.map((item) => item.messageId)).toEqual(['f1']);
    expect(result.partialFailures).toEqual([{ mailboxId: 'slow', errorCode: 'PROVIDER_TIMEOUT' }]);
    expect(store.readCalls[0]?.mailboxIds).toEqual(['fast']);
  });

  it('keeps other mailboxes usable when one adapter throws a GatewayError', async () => {
    const rows = [mailbox({ id: 'ok' }), mailbox({ id: 'rate-limited' }), mailbox({ id: 'boom' })];
    const result = await search({
      rows,
      adapters: {
        ok: createAdapter('ok', {
          items: [
            email({ mailboxId: 'ok', messageId: 'o1', receivedAt: '2026-08-06T00:00:00.000Z' }),
          ],
        }),
        'rate-limited': createAdapter('rate-limited', {
          fail: new GatewayError('PROVIDER_RATE_LIMIT', 'slow down', {
            retryable: true,
            correlationId: CORRELATION_ID,
          }),
        }),
        boom: createAdapter('boom', { fail: new TypeError('unexpected') }),
      },
    });

    expect(result.emails.map((item) => item.messageId)).toEqual(['o1']);
    expect(result.partialFailures).toEqual([
      { mailboxId: 'rate-limited', errorCode: 'PROVIDER_RATE_LIMIT' },
      { mailboxId: 'boom', errorCode: 'INTERNAL_ERROR' },
    ]);
  });

  it('reports an unknown mailbox id and a disconnected mailbox per mailbox', async () => {
    const rows = [mailbox({ id: 'a' }), mailbox({ id: 'stale', connectionStatus: 'revoked' })];
    const result = await search({
      rows,
      input: { mailboxIds: ['a', 'stale', 'ghost'] },
      adapters: {
        a: createAdapter('a', {
          items: [
            email({ mailboxId: 'a', messageId: 'a1', receivedAt: '2026-08-06T00:00:00.000Z' }),
          ],
        }),
      },
    });

    expect(result.emails.map((item) => item.messageId)).toEqual(['a1']);
    expect(result.partialFailures).toEqual([
      { mailboxId: 'stale', errorCode: 'AUTH_REQUIRED' },
      { mailboxId: 'ghost', errorCode: 'MAILBOX_NOT_FOUND' },
    ]);
  });

  it('reports UNSUPPORTED_OPERATION when no adapter exists for a mailbox', async () => {
    const rows = [mailbox({ id: 'microsoft-one', provider: 'microsoft' })];
    const result = await search({ rows, adapters: {} });
    expect(result.emails).toEqual([]);
    expect(result.partialFailures).toEqual([
      { mailboxId: 'microsoft-one', errorCode: 'UNSUPPORTED_OPERATION' },
    ]);
  });

  it('clamps the global limit and hands each mailbox its own incoming cursor', async () => {
    const rows = [mailbox({ id: 'a' }), mailbox({ id: 'b' })];
    const queries: Record<string, NormalizedSearchQuery> = {};
    const incoming = encodeSearchCursor({ a: 'cursor-a' });
    expect(incoming).toBeDefined();

    const result = await search({
      rows,
      input: { limit: 500, ...(incoming === undefined ? {} : { cursor: incoming }) },
      adapters: {
        a: createAdapter('a', {
          nextCursor: 'cursor-a-2',
          onSearch: (query) => {
            queries['a'] = query;
          },
          items: [
            email({ mailboxId: 'a', messageId: 'a1', receivedAt: '2026-08-06T00:00:00.000Z' }),
          ],
        }),
        b: createAdapter('b', {
          onSearch: (query) => {
            queries['b'] = query;
          },
          items: [],
        }),
      },
    });

    expect(queries['a']?.cursor).toBe('cursor-a');
    expect(queries['a']?.limit).toBe(50);
    expect(queries['b']?.cursor).toBeUndefined();
    expect(result.nextCursor).toBeDefined();
    expect(decodeSearchCursor(result.nextCursor, CORRELATION_ID)).toEqual({ a: 'cursor-a-2' });
  });
});

describe('single mailbox reads', () => {
  const rows = [
    mailbox({ id: 'a' }),
    mailbox({ id: 'off', enabled: false }),
    mailbox({ id: 'stale', connectionStatus: 'expired' }),
  ];
  const message = email({
    mailboxId: 'a',
    messageId: 'a1',
    textBody: 'full body',
    receivedAt: '2026-08-06T00:00:00.000Z',
  });
  const thread: NormalizedThread = {
    mailboxId: 'a',
    provider: 'gmail',
    threadId: 't1',
    subject: 'Subject',
    participants: [],
    messages: [message],
    lastActivityAt: '2026-08-06T00:00:00.000Z',
  };

  function service(store: MailboxStore) {
    return createMailSearchService({
      store,
      adapterFactory: factoryFor({ a: createAdapter('a', { items: [message], thread }) }),
      correlationId: CORRELATION_ID,
      timeoutMs: 50,
      now: () => new Date('2026-08-07T10:00:00.000Z'),
    });
  }

  it('returns the full message with its body and stamps the read timestamp', async () => {
    const store = createStore(rows);
    const result = await service(store).getEmailFromMailbox({
      mailboxId: 'a',
      messageId: 'a1',
    });
    expect(result.textBody).toBe('full body');
    expect(store.readCalls).toEqual([
      { mailboxIds: ['a'], at: new Date('2026-08-07T10:00:00.000Z') },
    ]);
  });

  it('returns the thread of a single mailbox', async () => {
    const store = createStore(rows);
    await expect(
      service(store).getThreadFromMailbox({ mailboxId: 'a', threadId: 't1' }),
    ).resolves.toBe(thread);
  });

  it.each([
    ['ghost', 'MAILBOX_NOT_FOUND'],
    ['off', 'MAILBOX_DISABLED'],
    ['stale', 'AUTH_REQUIRED'],
  ])('rejects mailbox %s with %s', async (mailboxId, code) => {
    const store = createStore(rows);
    await expect(
      service(store).getEmailFromMailbox({ mailboxId, messageId: 'a1' }),
    ).rejects.toMatchObject({ code });
    expect(store.readCalls).toEqual([]);
  });
});

describe('toEmailSummary', () => {
  it('removes both bodies and preserves the origin mailbox', () => {
    const summary = toEmailSummary(
      email({ mailboxId: 'a', messageId: 'a1', textBody: 't', htmlBody: '<p>h</p>' }),
    );
    expect(Object.keys(summary)).not.toContain('textBody');
    expect(Object.keys(summary)).not.toContain('htmlBody');
    expect(summary.mailboxId).toBe('a');
  });
});
