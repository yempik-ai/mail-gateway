// Outreach reply correlation. The gateway remembers every draft it
// created in `message_references`; this module scans the inbox of the mailboxes
// that carry such references and correlates incoming messages back to the
// campaign that produced them.
//
// The matching tiers are applied in reliability order and the winning tier is
// reported with its confidence, because a weak match must never be classified as
// a certain reply: the header-based tiers (0.8 and above) are facts, the
// recipient+subject+time tier (0.5) is a heuristic hint the caller must verify.

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { mailboxes, messageReferences, type Database } from '@yempik/database';
import { GatewayError } from '@yempik/core';
import type {
  GatewayErrorCode,
  MailProviderAdapter,
  NormalizedEmail,
  NormalizedSearchQuery,
} from '@yempik/core';
import {
  PROVIDER_TIMEOUT_MS,
  createDatabaseMailboxStore,
  resolveTargetMailboxes,
  toGatewayError,
  type AdapterFactory,
  type MailboxFailure,
  type MailboxRecord,
} from './mail-search.js';

export const DEFAULT_REPLY_LIMIT = 20;
export const MAX_REPLY_LIMIT = 50;
/** Candidates pulled per mailbox before matching; the caller limit applies after. */
export const CANDIDATE_FETCH_LIMIT = 50;
export const DEFAULT_REPLY_WINDOW_DAYS = 14;

export type ReplyMatchMethod =
  'thread' | 'inReplyTo' | 'references' | 'messageId' | 'recipientSubjectTime';

/** Reliability order of the match tiers, highest first. */
export const REPLY_MATCH_CONFIDENCE: Readonly<Record<ReplyMatchMethod, number>> = {
  thread: 0.95,
  inReplyTo: 0.9,
  references: 0.85,
  messageId: 0.8,
  recipientSubjectTime: 0.5,
};

/** At or above this the match rests on provider ids; below it, it is a hint. */
export const RELIABLE_MATCH_CONFIDENCE = 0.8;

/** One draft this gateway created, as remembered in `message_references`. */
export interface ReferenceRecord {
  id: string;
  mailboxId: string;
  campaignId: string;
  prospectId?: string | undefined;
  providerMessageId: string;
  threadId?: string | undefined;
  conversationId?: string | undefined;
  internetMessageId?: string | undefined;
  normalizedRecipient?: string | undefined;
  subject?: string | undefined;
  /** When the draft existed (`message_at`, falling back to the row timestamp). */
  createdAt: Date;
}

/**
 * The only persistence reply matching needs. Behind an interface so every
 * tier and merge decision is unit-testable without a live database.
 */
export interface ReplyMatchingStore {
  listReferences(campaignId?: string): Promise<ReferenceRecord[]>;
  listMailboxes(): Promise<MailboxRecord[]>;
}

// Optional members are declared `| undefined` so zod-parsed input (whose
// inferred output always includes `undefined`) flows in unchanged under
// exactOptionalPropertyTypes.
export interface ListOutreachRepliesInput {
  campaignId?: string | undefined;
  mailboxIds?: string[] | undefined;
  since?: string | undefined;
  unreadOnly?: boolean | undefined;
  limit?: number | undefined;
}

/** One matched reply, with the campaign it answers and the confidence of the match. */
export interface OutreachReply {
  campaignId: string;
  prospectId?: string;
  mailboxId: string;
  sourceMessageId: string;
  threadId?: string;
  from: string;
  subject: string;
  receivedAt: string;
  isUnread: boolean;
  snippet: string;
  matchMethod: ReplyMatchMethod;
  confidence: number;
}

export interface ListOutreachRepliesResult {
  replies: OutreachReply[];
  partialFailures: MailboxFailure[];
}

export interface ReplyMatch {
  reference: ReferenceRecord;
  matchMethod: ReplyMatchMethod;
  confidence: number;
}

export function clampReplyLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_REPLY_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_REPLY_LIMIT);
}

export function defaultReplyWindowStart(now: Date): string {
  return new Date(now.getTime() - DEFAULT_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Message-ids travel with or without angle brackets depending on the provider. */
function normalizeMessageId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeAddress(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Subject comparison modulo the reply/forward prefixes mail clients prepend,
 * so "Re: Quick question" is the same conversation as "Quick question".
 */
export function normalizeReplySubject(subject: string | undefined): string | undefined {
  if (subject === undefined) return undefined;
  let value = subject.trim();
  let previous = '';
  while (value !== previous) {
    previous = value;
    value = value.replace(/^(?:re|fwd|fw)\s*(?:\[\d+\])?\s*:\s*/i, '').trim();
  }
  const normalized = value.replace(/\s+/g, ' ').toLowerCase();
  return normalized === '' ? undefined : normalized;
}

function candidateTimestamp(candidate: NormalizedEmail): number | undefined {
  for (const value of [candidate.receivedAt, candidate.sentAt]) {
    if (value === undefined) continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function defined(values: (string | undefined)[]): string[] {
  return values.flatMap((value) => (value === undefined ? [] : [value]));
}

function matchOf(reference: ReferenceRecord, matchMethod: ReplyMatchMethod): ReplyMatch {
  return { reference, matchMethod, confidence: REPLY_MATCH_CONFIDENCE[matchMethod] };
}

/**
 * Pure tier ladder: the first (most reliable) tier that matches wins and
 * the candidate is never reported twice under a weaker tier. Drafts are never
 * candidates: a draft the gateway itself wrote is not a reply to itself.
 */
export function matchReply(
  candidate: NormalizedEmail,
  references: ReferenceRecord[],
): ReplyMatch | undefined {
  if (candidate.isDraft || references.length === 0) return undefined;

  // a. Provider thread / conversation identity.
  const threadIds = new Set(defined([candidate.threadId, candidate.conversationId]));
  if (threadIds.size > 0) {
    for (const reference of references) {
      const referenceIds = defined([reference.threadId, reference.conversationId]);
      if (referenceIds.some((id) => threadIds.has(id))) return matchOf(reference, 'thread');
    }
  }

  // b. In-Reply-To points straight at the draft we sent.
  const inReplyTo = normalizeMessageId(candidate.inReplyTo);
  if (inReplyTo !== undefined) {
    for (const reference of references) {
      if (normalizeMessageId(reference.internetMessageId) === inReplyTo) {
        return matchOf(reference, 'inReplyTo');
      }
    }
  }

  // c. The References chain still carries our message-id further down a thread.
  const chain = new Set(defined(candidate.references.map(normalizeMessageId)));
  if (chain.size > 0) {
    for (const reference of references) {
      const internetMessageId = normalizeMessageId(reference.internetMessageId);
      if (internetMessageId !== undefined && chain.has(internetMessageId)) {
        return matchOf(reference, 'references');
      }
    }
  }

  // d. Same internet message-id (rare: a copy of our own message coming back).
  const internetMessageId = normalizeMessageId(candidate.internetMessageId);
  if (internetMessageId !== undefined) {
    for (const reference of references) {
      if (normalizeMessageId(reference.internetMessageId) === internetMessageId) {
        return matchOf(reference, 'messageId');
      }
    }
  }

  // e. Heuristic: the prospect writes back, same subject, after our draft.
  const from = normalizeAddress(candidate.from?.address);
  const subject = normalizeReplySubject(candidate.subject);
  const at = candidateTimestamp(candidate);
  if (from !== undefined && subject !== undefined && at !== undefined) {
    for (const reference of references) {
      if (normalizeAddress(reference.normalizedRecipient) !== from) continue;
      if (normalizeReplySubject(reference.subject) !== subject) continue;
      if (at <= reference.createdAt.getTime()) continue;
      return matchOf(reference, 'recipientSubjectTime');
    }
  }

  return undefined;
}

/** A draft, or a message the mailbox sent itself, is never an incoming reply. */
export function isOwnMessage(candidate: NormalizedEmail, mailboxAddress: string): boolean {
  if (candidate.isDraft) return true;
  const from = normalizeAddress(candidate.from?.address);
  return from !== undefined && from === normalizeAddress(mailboxAddress);
}

function replyTimestamp(reply: OutreachReply): number | undefined {
  const parsed = Date.parse(reply.receivedAt);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Newest first; replies without a usable date sort last (stable within group). */
function compareRepliesDesc(a: OutreachReply, b: OutreachReply): number {
  const left = replyTimestamp(a);
  const right = replyTimestamp(b);
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

/** One message can match through several references: keep the strongest claim. */
export function dedupeReplies(replies: OutreachReply[]): OutreachReply[] {
  const best = new Map<string, OutreachReply>();
  for (const reply of replies) {
    const key = `${reply.mailboxId} ${reply.sourceMessageId}`;
    const previous = best.get(key);
    if (previous === undefined || reply.confidence > previous.confidence) best.set(key, reply);
  }
  return [...best.values()];
}

function toOutreachReply(
  candidate: NormalizedEmail,
  mailbox: MailboxRecord,
  references: ReferenceRecord[],
): OutreachReply | undefined {
  if (isOwnMessage(candidate, mailbox.emailAddress)) return undefined;
  const match = matchReply(candidate, references);
  if (match === undefined) return undefined;

  const threadId = candidate.threadId ?? candidate.conversationId;
  return {
    campaignId: match.reference.campaignId,
    mailboxId: mailbox.id,
    sourceMessageId: candidate.messageId,
    from: candidate.from?.address ?? '',
    subject: candidate.subject,
    receivedAt: candidate.receivedAt ?? candidate.sentAt ?? '',
    isUnread: !candidate.isRead,
    snippet: candidate.snippet ?? '',
    matchMethod: match.matchMethod,
    confidence: match.confidence,
    ...(match.reference.prospectId === undefined ? {} : { prospectId: match.reference.prospectId }),
    ...(threadId === undefined ? {} : { threadId }),
  };
}

function requireAdapter(
  adapterFactory: AdapterFactory,
  mailbox: MailboxRecord,
  correlationId: string,
): MailProviderAdapter {
  const adapter = adapterFactory(mailbox, correlationId);
  if (adapter === undefined) {
    throw new GatewayError(
      'UNSUPPORTED_OPERATION',
      `No provider adapter is configured for mailbox ${mailbox.id}`,
      { retryable: false, correlationId },
    );
  }
  return adapter;
}

// Mirrors the per-provider deadline of mail-search: one slow mailbox degrades
// into a partial failure instead of stalling the whole scan.
async function withProviderTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  mailboxId: string,
  correlationId: string,
): Promise<T> {
  // When the timeout wins the race the provider promise still settles later:
  // absorb its rejection so it never surfaces as an unhandled rejection.
  void operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new GatewayError(
          'PROVIDER_TIMEOUT',
          `Mailbox ${mailboxId} did not answer within ${timeoutMs}ms`,
          { retryable: true, correlationId },
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function candidateQuery(since: string, unreadOnly: boolean | undefined): NormalizedSearchQuery {
  return {
    folder: 'inbox',
    after: since,
    limit: CANDIDATE_FETCH_LIMIT,
    ...(unreadOnly === undefined ? {} : { unreadOnly }),
  };
}

export interface FindOutreachRepliesOptions {
  store: ReplyMatchingStore;
  adapterFactory: AdapterFactory;
  correlationId: string;
  input: ListOutreachRepliesInput;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

type MailboxOutcome =
  | { mailboxId: string; replies: OutreachReply[] }
  | { mailboxId: string; errorCode: GatewayErrorCode };

export async function findOutreachReplies(
  options: FindOutreachRepliesOptions,
): Promise<ListOutreachRepliesResult> {
  const { store, adapterFactory, correlationId, input } = options;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const limit = clampReplyLimit(input.limit);
  const since = input.since ?? defaultReplyWindowStart(now());

  const [references, mailboxRows] = await Promise.all([
    store.listReferences(input.campaignId),
    store.listMailboxes(),
  ]);

  const byMailbox = new Map<string, ReferenceRecord[]>();
  for (const reference of references) {
    const bucket = byMailbox.get(reference.mailboxId);
    if (bucket === undefined) byMailbox.set(reference.mailboxId, [reference]);
    else bucket.push(reference);
  }

  const { targets, failures } = resolveTargetMailboxes(mailboxRows, input.mailboxIds);
  // A mailbox that never carried an outreach draft has nothing to correlate:
  // it is skipped entirely rather than searched and discarded.
  const scans = targets.flatMap((mailbox) => {
    const mailboxReferences = byMailbox.get(mailbox.id);
    return mailboxReferences === undefined || mailboxReferences.length === 0
      ? []
      : [{ mailbox, references: mailboxReferences }];
  });

  const outcomes = await Promise.all(
    scans.map(async ({ mailbox, references: mailboxReferences }): Promise<MailboxOutcome> => {
      try {
        const adapter = requireAdapter(adapterFactory, mailbox, correlationId);
        const page = await withProviderTimeout(
          adapter.searchEmails(candidateQuery(since, input.unreadOnly)),
          timeoutMs,
          mailbox.id,
          correlationId,
        );
        const replies = page.items.flatMap((candidate) => {
          const reply = toOutreachReply(candidate, mailbox, mailboxReferences);
          return reply === undefined ? [] : [reply];
        });
        return { mailboxId: mailbox.id, replies };
      } catch (error) {
        return { mailboxId: mailbox.id, errorCode: toGatewayError(error, correlationId).code };
      }
    }),
  );

  const partialFailures = [...failures];
  const matched: OutreachReply[] = [];
  for (const outcome of outcomes) {
    if ('errorCode' in outcome) {
      partialFailures.push({ mailboxId: outcome.mailboxId, errorCode: outcome.errorCode });
      continue;
    }
    matched.push(...outcome.replies);
  }

  return {
    replies: dedupeReplies(matched).sort(compareRepliesDesc).slice(0, limit),
    partialFailures,
  };
}

export interface ReplyMatchingService {
  listOutreachReplies(input: ListOutreachRepliesInput): Promise<ListOutreachRepliesResult>;
}

export interface ReplyMatchingOptions {
  store: ReplyMatchingStore;
  adapterFactory: AdapterFactory;
  correlationId: string;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export function createReplyMatchingService(options: ReplyMatchingOptions): ReplyMatchingService {
  const base = {
    store: options.store,
    adapterFactory: options.adapterFactory,
    correlationId: options.correlationId,
    timeoutMs: options.timeoutMs ?? PROVIDER_TIMEOUT_MS,
    now: options.now ?? (() => new Date()),
  };
  return {
    listOutreachReplies: (input) => findOutreachReplies({ ...base, input }),
  };
}

export function createDatabaseReplyMatchingStore(
  database: Database,
  correlationId: string,
): ReplyMatchingStore {
  const mailboxStore = createDatabaseMailboxStore(database, correlationId);
  return {
    listMailboxes: () => mailboxStore.listMailboxes(),
    async listReferences(campaignId) {
      try {
        // Only references that belong to a campaign are correlatable, and only
        // mailboxes we can still read are worth scanning.
        const rows = await database
          .select({
            id: messageReferences.id,
            mailboxId: messageReferences.mailboxId,
            campaignId: messageReferences.campaignId,
            prospectId: messageReferences.prospectId,
            providerMessageId: messageReferences.providerMessageId,
            threadId: messageReferences.threadId,
            conversationId: messageReferences.conversationId,
            internetMessageId: messageReferences.internetMessageId,
            normalizedRecipient: messageReferences.normalizedRecipient,
            subject: messageReferences.subject,
            messageAt: messageReferences.messageAt,
            createdAt: messageReferences.createdAt,
          })
          .from(messageReferences)
          .innerJoin(mailboxes, eq(mailboxes.id, messageReferences.mailboxId))
          .where(
            and(
              isNotNull(messageReferences.campaignId),
              eq(mailboxes.enabled, true),
              eq(mailboxes.connectionStatus, 'connected'),
              ...(campaignId === undefined ? [] : [eq(messageReferences.campaignId, campaignId)]),
            ),
          )
          .orderBy(desc(messageReferences.createdAt));

        return rows.flatMap((row) =>
          row.campaignId === null
            ? []
            : [
                {
                  id: row.id,
                  mailboxId: row.mailboxId,
                  campaignId: row.campaignId,
                  providerMessageId: row.providerMessageId,
                  createdAt: row.messageAt ?? row.createdAt,
                  ...(row.prospectId === null ? {} : { prospectId: row.prospectId }),
                  ...(row.threadId === null ? {} : { threadId: row.threadId }),
                  ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
                  ...(row.internetMessageId === null
                    ? {}
                    : { internetMessageId: row.internetMessageId }),
                  ...(row.normalizedRecipient === null
                    ? {}
                    : { normalizedRecipient: row.normalizedRecipient }),
                  ...(row.subject === null ? {} : { subject: row.subject }),
                },
              ],
        );
      } catch (error) {
        throw new GatewayError('DATABASE_ERROR', 'The outreach reference registry is unavailable', {
          retryable: true,
          correlationId,
          cause: error,
        });
      }
    },
  };
}
