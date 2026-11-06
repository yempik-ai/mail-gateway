// Cross-provider read service. Provider adapters are
// injected through an AdapterFactory so this module never imports a concrete
// adapter package: Gmail and Microsoft implementations can land independently.
//
// Aggregate semantics: results from every requested mailbox,
// sorted by date descending, always carrying their origin mailbox, partial
// results with an explicit per-mailbox failure list, no duplicates, a global
// limit and a per-provider timeout.

import { inArray } from 'drizzle-orm';
import { mailboxes, type Database } from '@yempik/database';
import { GatewayError } from '@yempik/core';
import type {
  GatewayErrorCode,
  MailProviderAdapter,
  MailboxConnectionStatus,
  MailboxProvider,
  NormalizedEmail,
  NormalizedSearchQuery,
  NormalizedThread,
  PaginatedResult,
  SearchFolder,
} from '@yempik/core';

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;
export const PROVIDER_TIMEOUT_MS = 10_000;
export const MAX_BODY_CHARS = 50_000;

export type BodyFormat = 'text' | 'html' | 'both';

/**
 * Agent-context hygiene for message bodies: plain text by default, HTML only
 * on request (falling back to HTML when no text part exists), and hard
 * truncation with an explicit marker so oversized newsletters cannot flood
 * the caller's context window.
 */
export function shapeEmailBody(
  email: NormalizedEmail,
  format: BodyFormat = 'text',
  maxChars = MAX_BODY_CHARS,
): NormalizedEmail {
  const clamp = (value: string | undefined): string | undefined =>
    value !== undefined && value.length > maxChars
      ? `${value.slice(0, maxChars)}… [truncated; full length ${value.length} chars]`
      : value;

  const { textBody, htmlBody, ...rest } = email;
  const text = format === 'html' ? undefined : clamp(textBody);
  const html =
    format === 'text' ? (textBody === undefined ? clamp(htmlBody) : undefined) : clamp(htmlBody);
  return {
    ...rest,
    ...(text === undefined ? {} : { textBody: text }),
    ...(html === undefined ? {} : { htmlBody: html }),
  };
}

/** Minimal mailbox identity an adapter needs to bind itself to one mailbox. */
export interface AdapterMailboxContext {
  id: string;
  provider: MailboxProvider;
  emailAddress: string;
  aliases: string[];
}

/**
 * Seam between the read tools and the provider adapters. The concrete factory
 * is wired by the composition root; returning `undefined` means "no adapter
 * implementation for this mailbox yet" and surfaces as UNSUPPORTED_OPERATION.
 */
export type AdapterFactory = (
  mailbox: AdapterMailboxContext,
  correlationId: string,
) => MailProviderAdapter | undefined;

export interface MailboxRecord extends AdapterMailboxContext {
  enabled: boolean;
  connectionStatus: MailboxConnectionStatus;
}

/**
 * The only persistence this service needs. Keeping it behind an interface makes
 * every routing/merge decision unit-testable without a live database.
 */
export interface MailboxStore {
  listMailboxes(): Promise<MailboxRecord[]>;
  recordSuccessfulRead(mailboxIds: string[], at: Date): Promise<void>;
}

// Optional members are declared `| undefined` so objects parsed by zod (whose
// inferred output always includes `undefined`) flow in unchanged under
// exactOptionalPropertyTypes.
export interface SearchEmailsInput {
  mailboxIds?: string[] | undefined;
  text?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  unreadOnly?: boolean | undefined;
  hasAttachment?: boolean | undefined;
  folder?: SearchFolder | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface GetEmailInput {
  mailboxId: string;
  messageId: string;
  includeBody?: boolean | undefined;
}

export interface GetThreadInput {
  mailboxId: string;
  threadId: string;
}

export interface MailboxFailure {
  mailboxId: string;
  errorCode: GatewayErrorCode;
}

/** Search hits never carry bodies: the body is fetched on demand only. */
export type NormalizedEmailSummary = Omit<NormalizedEmail, 'textBody' | 'htmlBody'>;

export interface SearchEmailsResult {
  emails: NormalizedEmailSummary[];
  partialFailures: MailboxFailure[];
  nextCursor?: string;
}

export interface MailboxResolution {
  targets: MailboxRecord[];
  failures: MailboxFailure[];
}

export function toGatewayError(error: unknown, correlationId: string): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError('INTERNAL_ERROR', 'Unexpected gateway failure', {
    retryable: false,
    correlationId,
    cause: error,
  });
}

export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);
}

/** Opaque per-mailbox cursor map: providers never see each other's cursors. */
export function encodeSearchCursor(cursors: Record<string, string>): string | undefined {
  const entries = Object.entries(cursors);
  if (entries.length === 0) return undefined;
  return Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf8').toString('base64url');
}

export function decodeSearchCursor(
  cursor: string | undefined,
  correlationId: string,
): Record<string, string> {
  if (cursor === undefined || cursor === '') return {};
  const invalid = () =>
    new GatewayError('INVALID_QUERY', 'The pagination cursor is not valid', {
      retryable: false,
      correlationId,
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid();
  const decoded: Record<string, string> = {};
  for (const [mailboxId, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw invalid();
    decoded[mailboxId] = value;
  }
  return decoded;
}

function receivedAtValue(email: NormalizedEmail): number | undefined {
  if (email.receivedAt === undefined) return undefined;
  const parsed = Date.parse(email.receivedAt);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Newest first; messages without a usable date sort last (stable within group). */
export function compareByReceivedAtDesc(a: NormalizedEmail, b: NormalizedEmail): number {
  const left = receivedAtValue(a);
  const right = receivedAtValue(b);
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

export function toEmailSummary(email: NormalizedEmail): NormalizedEmailSummary {
  const summary: NormalizedEmail = { ...email };
  delete summary.textBody;
  delete summary.htmlBody;
  return summary;
}

/** Sort descending, drop duplicates of mailbox+message, then apply the global limit. */
export function mergeSearchPages(pages: NormalizedEmail[][], limit: number): NormalizedEmail[] {
  const sorted = pages.flat().sort(compareByReceivedAtDesc);
  const seen = new Set<string>();
  const merged: NormalizedEmail[] = [];
  for (const email of sorted) {
    const key = `${email.mailboxId}\0${email.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(email);
    if (merged.length >= limit) break;
  }
  return merged;
}

/**
 * A mailbox is queryable when it is enabled and connected. Explicitly requested
 * mailboxes that fail those checks become per-mailbox failures; mailboxes that
 * are merely switched off are skipped silently when no ids were requested.
 */
export function resolveTargetMailboxes(
  rows: MailboxRecord[],
  requestedIds?: string[],
): MailboxResolution {
  const targets: MailboxRecord[] = [];
  const failures: MailboxFailure[] = [];

  if (requestedIds === undefined) {
    for (const row of rows) {
      if (!row.enabled) continue;
      if (row.connectionStatus === 'connected') targets.push(row);
      else failures.push({ mailboxId: row.id, errorCode: 'AUTH_REQUIRED' });
    }
    return { targets, failures };
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const mailboxId of new Set(requestedIds)) {
    const row = byId.get(mailboxId);
    if (row === undefined) failures.push({ mailboxId, errorCode: 'MAILBOX_NOT_FOUND' });
    else if (!row.enabled) failures.push({ mailboxId, errorCode: 'MAILBOX_DISABLED' });
    else if (row.connectionStatus !== 'connected')
      failures.push({ mailboxId, errorCode: 'AUTH_REQUIRED' });
    else targets.push(row);
  }
  return { targets, failures };
}

function resolveSingleMailbox(
  rows: MailboxRecord[],
  mailboxId: string,
  correlationId: string,
): MailboxRecord {
  const row = rows.find((candidate) => candidate.id === mailboxId);
  const fail = (code: GatewayErrorCode, message: string): never => {
    throw new GatewayError(code, message, { retryable: false, correlationId });
  };
  if (row === undefined) return fail('MAILBOX_NOT_FOUND', `Mailbox ${mailboxId} is not registered`);
  if (!row.enabled) return fail('MAILBOX_DISABLED', `Mailbox ${mailboxId} is disabled`);
  if (row.connectionStatus !== 'connected') {
    return fail('AUTH_REQUIRED', `Mailbox ${mailboxId} requires reconnection`);
  }
  return row;
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

function providerQuery(
  input: SearchEmailsInput,
  limit: number,
  cursor: string | undefined,
): NormalizedSearchQuery {
  return {
    limit,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.after === undefined ? {} : { after: input.after }),
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.unreadOnly === undefined ? {} : { unreadOnly: input.unreadOnly }),
    ...(input.hasAttachment === undefined ? {} : { hasAttachment: input.hasAttachment }),
    ...(input.folder === undefined ? {} : { folder: input.folder }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** Bookkeeping only: a failed timestamp write must not fail a successful read. */
async function markRead(store: MailboxStore, mailboxIds: string[], at: Date): Promise<void> {
  if (mailboxIds.length === 0) return;
  await store.recordSuccessfulRead(mailboxIds, at).catch(() => undefined);
}

export interface MailReadOptions {
  store: MailboxStore;
  adapterFactory: AdapterFactory;
  correlationId: string;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface SearchAcrossMailboxesOptions extends MailReadOptions {
  input: SearchEmailsInput;
}

export interface GetEmailFromMailboxOptions extends MailReadOptions {
  input: GetEmailInput;
}

export interface GetThreadFromMailboxOptions extends MailReadOptions {
  input: GetThreadInput;
}

type MailboxOutcome =
  | { mailboxId: string; page: PaginatedResult<NormalizedEmail> }
  | { mailboxId: string; errorCode: GatewayErrorCode };

export async function searchAcrossMailboxes(
  options: SearchAcrossMailboxesOptions,
): Promise<SearchEmailsResult> {
  const { store, adapterFactory, correlationId, input } = options;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const limit = clampSearchLimit(input.limit);
  const cursors = decodeSearchCursor(input.cursor, correlationId);

  const { targets, failures } = resolveTargetMailboxes(
    await store.listMailboxes(),
    input.mailboxIds,
  );

  const outcomes = await Promise.all(
    targets.map(async (mailbox): Promise<MailboxOutcome> => {
      try {
        const adapter = requireAdapter(adapterFactory, mailbox, correlationId);
        const page = await withProviderTimeout(
          adapter.searchEmails(providerQuery(input, limit, cursors[mailbox.id])),
          timeoutMs,
          mailbox.id,
          correlationId,
        );
        return { mailboxId: mailbox.id, page };
      } catch (error) {
        return { mailboxId: mailbox.id, errorCode: toGatewayError(error, correlationId).code };
      }
    }),
  );

  const partialFailures = [...failures];
  const pages: NormalizedEmail[][] = [];
  const nextCursors: Record<string, string> = {};
  const succeeded: string[] = [];
  for (const outcome of outcomes) {
    if ('errorCode' in outcome) {
      partialFailures.push({ mailboxId: outcome.mailboxId, errorCode: outcome.errorCode });
      continue;
    }
    succeeded.push(outcome.mailboxId);
    pages.push(outcome.page.items);
    if (outcome.page.nextCursor !== undefined) {
      nextCursors[outcome.mailboxId] = outcome.page.nextCursor;
    }
  }

  await markRead(store, succeeded, now());

  const nextCursor = encodeSearchCursor(nextCursors);
  return {
    emails: mergeSearchPages(pages, limit).map(toEmailSummary),
    partialFailures,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export async function getEmailFromMailbox(
  options: GetEmailFromMailboxOptions,
): Promise<NormalizedEmail> {
  const { store, adapterFactory, correlationId, input } = options;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  const mailbox = resolveSingleMailbox(await store.listMailboxes(), input.mailboxId, correlationId);
  const adapter = requireAdapter(adapterFactory, mailbox, correlationId);
  const email = await withProviderTimeout(
    adapter.getEmail(input.messageId, { includeBody: input.includeBody ?? true }),
    timeoutMs,
    mailbox.id,
    correlationId,
  );
  await markRead(store, [mailbox.id], now());
  return email;
}

export async function getThreadFromMailbox(
  options: GetThreadFromMailboxOptions,
): Promise<NormalizedThread> {
  const { store, adapterFactory, correlationId, input } = options;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  const mailbox = resolveSingleMailbox(await store.listMailboxes(), input.mailboxId, correlationId);
  const adapter = requireAdapter(adapterFactory, mailbox, correlationId);
  const thread = await withProviderTimeout(
    adapter.getThread(input.threadId),
    timeoutMs,
    mailbox.id,
    correlationId,
  );
  await markRead(store, [mailbox.id], now());
  return thread;
}

export interface MailSearchService {
  searchAcrossMailboxes(input: SearchEmailsInput): Promise<SearchEmailsResult>;
  getEmailFromMailbox(input: GetEmailInput): Promise<NormalizedEmail>;
  getThreadFromMailbox(input: GetThreadInput): Promise<NormalizedThread>;
}

export function createMailSearchService(options: MailReadOptions): MailSearchService {
  const base = {
    store: options.store,
    adapterFactory: options.adapterFactory,
    correlationId: options.correlationId,
    timeoutMs: options.timeoutMs ?? PROVIDER_TIMEOUT_MS,
    now: options.now ?? (() => new Date()),
  };
  return {
    searchAcrossMailboxes: (input) => searchAcrossMailboxes({ ...base, input }),
    getEmailFromMailbox: (input) => getEmailFromMailbox({ ...base, input }),
    getThreadFromMailbox: (input) => getThreadFromMailbox({ ...base, input }),
  };
}

export function createDatabaseMailboxStore(
  database: Database,
  correlationId: string,
): MailboxStore {
  return {
    async listMailboxes() {
      try {
        return await database
          .select({
            id: mailboxes.id,
            provider: mailboxes.provider,
            emailAddress: mailboxes.emailAddress,
            aliases: mailboxes.aliases,
            enabled: mailboxes.enabled,
            connectionStatus: mailboxes.connectionStatus,
          })
          .from(mailboxes)
          .orderBy(mailboxes.routingPriority, mailboxes.id);
      } catch (error) {
        throw new GatewayError('DATABASE_ERROR', 'The mailbox registry is unavailable', {
          retryable: true,
          correlationId,
          cause: error,
        });
      }
    },
    async recordSuccessfulRead(mailboxIds, at) {
      if (mailboxIds.length === 0) return;
      // One statement for every touched mailbox instead of a round trip each.
      await database
        .update(mailboxes)
        .set({ lastSuccessfulReadAt: at })
        .where(inArray(mailboxes.id, mailboxIds));
    },
  };
}
