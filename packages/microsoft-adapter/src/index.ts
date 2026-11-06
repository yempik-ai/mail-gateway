import {
  appendQuotedOriginal,
  extractHtmlBodyContent,
  GatewayError,
  textToHtml,
  type AccessTokenProvider,
  type GatewayErrorCode,
  type MailDraftAdapter,
  type MailProviderAdapter,
  type NormalizedEmail,
  type NormalizedEmailAddress,
  type NormalizedSearchQuery,
  type NormalizedThread,
  type ProviderDraftInput,
  type ProviderDraftSnapshot,
  type ProviderDraftUpdate,
  type ProviderReplyDraftInput,
  type ProviderSendReceipt,
} from '@yempik/core';

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_ORIGIN_PREFIX = 'https://graph.microsoft.com/';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;

const SUMMARY_FIELDS = [
  'id',
  'conversationId',
  'internetMessageId',
  'subject',
  'bodyPreview',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'replyTo',
  'isRead',
  'isDraft',
  'hasAttachments',
  'receivedDateTime',
  'sentDateTime',
  'webLink',
  'categories',
  'parentFolderId',
] as const;

const BODY_FIELDS = [...SUMMARY_FIELDS, 'body', 'uniqueBody'] as const;

const DRAFT_FIELDS = [
  'id',
  'subject',
  'isDraft',
  'conversationId',
  'internetMessageId',
  'webLink',
  'from',
  'toRecipients',
] as const;

const QUOTE_SOURCE_FIELDS = ['body', 'from', 'sentDateTime', 'receivedDateTime'] as const;

/**
 * Id of the container that holds the gateway-written part of an Outlook reply
 * draft. Graph composes the quoted conversation only once, at createReply, so a
 * later body update must swap this container's content and leave the quote
 * Graph wrote around it untouched.
 */
export const REPLY_BODY_CONTAINER_ID = 'yempik-reply-body';
/** Class on the same container, so the marker is also visible to CSS and to humans reading the HTML. */
export const REPLY_BODY_CONTAINER_CLASS = 'yempik_reply_body';
/** Class on the wrapper of the quote Graph composed, kept outside the body container. */
export const REPLY_HISTORY_CLASS = 'yempik_reply_history';

interface MicrosoftAdapterOptions {
  mailboxId: string;
  emailAddress: string;
  aliases?: string[];
  correlationId: string;
  tokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
}

interface GraphEmailAddress {
  name?: string | null;
  address?: string | null;
}

interface GraphRecipient {
  emailAddress?: GraphEmailAddress | null;
}

interface GraphItemBody {
  contentType?: string | null;
  content?: string | null;
}

interface GraphMessage {
  id?: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string | null;
  bodyPreview?: string;
  body?: GraphItemBody | null;
  uniqueBody?: GraphItemBody | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  receivedDateTime?: string;
  sentDateTime?: string;
  webLink?: string;
  categories?: string[];
  parentFolderId?: string;
}

interface GraphMessageList {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
}

type NotFoundCode = Extract<
  GatewayErrorCode,
  'MESSAGE_NOT_FOUND' | 'THREAD_NOT_FOUND' | 'DRAFT_NOT_FOUND'
>;

type GraphMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface GraphRequestOptions {
  method?: GraphMethod;
  body?: unknown;
  notFoundCode?: NotFoundCode;
}

type GraphQueryTranslation =
  { mode: 'search'; search: string } | { mode: 'filter'; filter?: string; orderby: string };

function graphDate(value: string): string {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function graphDateTime(value: string): string {
  return `${graphDate(value)}T00:00:00Z`;
}

function quoteKqlPhrase(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function quoteODataString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Translates a provider-neutral query without performing I/O or mutating the input. */
export function translateGraphQuery(query: NormalizedSearchQuery): GraphQueryTranslation {
  if (query.text) {
    const terms = [query.text];
    if (query.from) terms.push(`from:${query.from}`);
    if (query.to) terms.push(`to:${query.to}`);
    if (query.subject) terms.push(`subject:${quoteKqlPhrase(query.subject)}`);
    if (query.hasAttachment !== undefined) {
      terms.push(`hasattachments:${String(query.hasAttachment)}`);
    }
    if (query.unreadOnly) terms.push('isread:false');
    if (query.after) terms.push(`received>=${graphDate(query.after)}`);
    if (query.before) terms.push(`received<${graphDate(query.before)}`);

    // Graph ranks search results by relevance and does not permit filter/order clauses here.
    return { mode: 'search', search: terms.join(' ') };
  }

  const terms: string[] = [];
  if (query.from) {
    terms.push(`from/emailAddress/address eq ${quoteODataString(query.from)}`);
  }
  if (query.to) {
    terms.push(
      `toRecipients/any(recipient:recipient/emailAddress/address eq ${quoteODataString(query.to)})`,
    );
  }
  if (query.subject) terms.push(`contains(subject, ${quoteODataString(query.subject)})`);
  if (query.unreadOnly) terms.push('isRead eq false');
  if (query.hasAttachment !== undefined) {
    terms.push(`hasAttachments eq ${String(query.hasAttachment)}`);
  }
  if (query.after) terms.push(`receivedDateTime ge ${graphDateTime(query.after)}`);
  if (query.before) terms.push(`receivedDateTime lt ${graphDateTime(query.before)}`);

  return {
    mode: 'filter',
    orderby: 'receivedDateTime desc',
    ...(terms.length === 0 ? {} : { filter: terms.join(' and ') }),
  };
}

/** Maps a provider-neutral folder onto the corresponding Graph message collection. */
export function folderPath(folder: NormalizedSearchQuery['folder']): string {
  switch (folder) {
    case 'inbox':
      return '/me/mailFolders/inbox/messages';
    case 'sent':
      return '/me/mailFolders/sentitems/messages';
    case 'drafts':
      return '/me/mailFolders/drafts/messages';
    case 'archive':
      return '/me/mailFolders/archive/messages';
    case 'all':
    case undefined:
      return '/me/messages';
  }
  return '/me/messages';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

function isTimeoutError(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.name === 'string' &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function gatewayError(
  code: GatewayErrorCode,
  message: string,
  correlationId: string,
  retryable: boolean,
  details: { cause?: unknown; retryAfterSeconds?: number } = {},
): GatewayError {
  return new GatewayError(code, message, {
    retryable,
    correlationId,
    ...(details.cause === undefined ? {} : { cause: details.cause }),
    ...(details.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: details.retryAfterSeconds }),
  });
}

function responseError(
  response: Response,
  correlationId: string,
  notFoundCode?: NotFoundCode,
): GatewayError {
  if (response.status === 401) {
    return gatewayError(
      'TOKEN_EXPIRED',
      'Microsoft rejected the access token',
      correlationId,
      false,
    );
  }

  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response);
    return gatewayError(
      'PROVIDER_RATE_LIMIT',
      'Microsoft Graph rate limit exceeded',
      correlationId,
      true,
      retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter },
    );
  }

  if (response.status === 404 && notFoundCode) {
    const notFoundMessage = {
      MESSAGE_NOT_FOUND: 'Microsoft message not found',
      THREAD_NOT_FOUND: 'Microsoft thread not found',
      DRAFT_NOT_FOUND: 'Microsoft draft not found',
    } as const;
    return gatewayError(notFoundCode, notFoundMessage[notFoundCode], correlationId, false);
  }

  if (response.status >= 500) {
    return gatewayError(
      'PROVIDER_UNAVAILABLE',
      'Microsoft Graph is temporarily unavailable',
      correlationId,
      true,
    );
  }

  if (response.status === 400) {
    return gatewayError(
      'INVALID_QUERY',
      'Microsoft Graph rejected the request',
      correlationId,
      false,
    );
  }

  return gatewayError(
    response.status === 403 ? 'AUTH_REQUIRED' : 'PROVIDER_REJECTED',
    `Microsoft Graph request failed with status ${response.status}`,
    correlationId,
    false,
  );
}

function normalizedAddress(
  recipient: GraphRecipient | null | undefined,
): NormalizedEmailAddress | undefined {
  const address = recipient?.emailAddress?.address?.trim();
  if (!address) return undefined;
  const name = recipient?.emailAddress?.name?.trim();
  return name ? { name, address } : { address };
}

function normalizedAddresses(recipients: GraphRecipient[] | undefined): NormalizedEmailAddress[] {
  return (recipients ?? []).flatMap((recipient) => {
    const address = normalizedAddress(recipient);
    return address === undefined ? [] : [address];
  });
}

function graphRecipients(addresses: string[]): GraphRecipient[] {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

/** The sender with its display name; Graph otherwise shows the mailbox default name. */
function graphFrom(address: string, displayName: string | undefined): GraphRecipient {
  const name = displayName?.trim();
  return { emailAddress: name ? { address, name } : { address } };
}

/** The new body as HTML, the only form a body can take once a quote is attached to it. */
function newBodyHtml(input: { textBody?: string; htmlBody?: string }): string {
  return input.htmlBody ?? textToHtml(input.textBody ?? '');
}

/** Inner HTML of a Graph body, whatever representation the mailbox stores it in. */
function graphBodyHtml(body: GraphItemBody | null | undefined): string {
  const content = body?.content ?? '';
  return body?.contentType?.toLowerCase() === 'text'
    ? textToHtml(content)
    : extractHtmlBodyContent(content);
}

function graphDraftBody(input: { textBody?: string; htmlBody?: string }): {
  contentType: 'HTML' | 'Text';
  content: string;
} {
  // Graph accepts one body representation. When both are present, HTML wins and text is ignored.
  if (input.htmlBody !== undefined) {
    return { contentType: 'HTML', content: input.htmlBody };
  }
  return { contentType: 'Text', content: input.textBody ?? '' };
}

/** Body of a fresh reply draft: the new body in the marked container, Graph's quote below it. */
function replyDraftHtml(newHtml: string, graphQuotedHtml: string): string {
  const replyBody = `<div id="${REPLY_BODY_CONTAINER_ID}" class="${REPLY_BODY_CONTAINER_CLASS}">${newHtml}</div>`;
  return graphQuotedHtml.trim().length === 0
    ? replyBody
    : `${replyBody}<div class="${REPLY_HISTORY_CLASS}">${graphQuotedHtml}</div>`;
}

interface HtmlTag {
  /** Lower-cased element name. */
  name: string;
  closing: boolean;
  /** Raw text between the element name and the closing `>`. */
  attributes: string;
  /** Index just past the tag's `>`. */
  end: number;
}

const TAG_NAME = /[a-z][a-z0-9-]*/iy;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

/** The tag starting at `start` (a `<`), or undefined when the `<` does not open a tag. */
function tagAt(html: string, start: number): HtmlTag | undefined {
  const closing = html[start + 1] === '/';
  TAG_NAME.lastIndex = start + (closing ? 2 : 1);
  const name = TAG_NAME.exec(html)?.[0];
  if (name === undefined) return undefined;
  const attributesStart = TAG_NAME.lastIndex;
  // Walk to the closing `>`, skipping quoted attribute values: a `>` inside
  // style="a>b" or title="x > y" does not end the tag.
  let index = attributesStart;
  while (index < html.length) {
    const character = html[index];
    if (character === '>') {
      return {
        name: name.toLowerCase(),
        closing,
        attributes: html.slice(attributesStart, index),
        end: index + 1,
      };
    }
    if (character === '=') {
      index += 1;
      while (index < html.length && /\s/u.test(html[index] ?? '')) index += 1;
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, index + 1);
        if (close === -1) return undefined;
        index = close + 1;
        continue;
      }
      continue;
    }
    index += 1;
  }
  return undefined;
}

function hasReplyBodyId(attributes: string): boolean {
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    if (match[1]?.toLowerCase() !== 'id') continue;
    const value = match[2] ?? match[3] ?? match[4];
    if (value === REPLY_BODY_CONTAINER_ID) return true;
  }
  return false;
}

/**
 * Bounds of the inner HTML of the reply-body container, or undefined when the
 * container is missing or never closed. Nested divs are counted so the match is
 * the container's own `</div>`, not the first one inside the body. Comments
 * and the raw text of <style>/<script> are skipped because a `<div` there is
 * not markup. The first container in document order wins: ours is written
 * before the quoted history, and Exchange rewrites ids inside quoted messages
 * (`x_` prefix), so a container quoted from an earlier reply does not match.
 */
function findReplyBodyContainer(
  html: string,
): { innerStart: number; innerEnd: number } | undefined {
  let innerStart: number | undefined;
  let depth = 0;
  let position = 0;
  while (position < html.length) {
    const start = html.indexOf('<', position);
    if (start === -1) return undefined;
    if (html.startsWith('<!--', start)) {
      const close = html.indexOf('-->', start + 4);
      if (close === -1) return undefined;
      position = close + 3;
      continue;
    }
    const tag = tagAt(html, start);
    if (tag === undefined) {
      position = start + 1;
      continue;
    }
    position = tag.end;
    if (!tag.closing && (tag.name === 'style' || tag.name === 'script')) {
      const closer = new RegExp(`</${tag.name}\\b`, 'giu');
      closer.lastIndex = position;
      const match = closer.exec(html);
      if (match === null) return undefined;
      position = match.index;
      continue;
    }
    if (tag.name !== 'div') continue;
    if (innerStart === undefined) {
      if (!tag.closing && hasReplyBodyId(tag.attributes)) {
        innerStart = tag.end;
        depth = 1;
      }
      continue;
    }
    // HTML has no self-closing div: `<div/>` still opens an element.
    depth += tag.closing ? -1 : 1;
    if (depth === 0) return { innerStart, innerEnd: start };
  }
  return undefined;
}

/**
 * The stored draft body with only the reply-body container's content replaced,
 * every other byte (Graph's document wrapper, the quoted history) unchanged.
 * Undefined when the draft carries no container to replace.
 */
function replaceReplyBody(
  body: GraphItemBody | null | undefined,
  newHtml: string,
): string | undefined {
  if (body?.contentType?.toLowerCase() !== 'html') return undefined;
  const content = body.content ?? '';
  const container = findReplyBodyContainer(content);
  if (container === undefined) return undefined;
  return `${content.slice(0, container.innerStart)}${newHtml}${content.slice(container.innerEnd)}`;
}

function draftSnapshot(message: GraphMessage): ProviderDraftSnapshot {
  const id = message.id ?? '';
  const conversationId = message.conversationId;
  const internetMessageId = message.internetMessageId;
  const providerWebUrl = message.webLink;
  const subject = message.subject ?? undefined;
  const from = normalizedAddress(message.from)?.address;
  const to = normalizedAddresses(message.toRecipients).map((recipient) => recipient.address);

  return {
    providerDraftId: id,
    providerMessageId: id,
    ...(conversationId === undefined ? {} : { conversationId, threadId: conversationId }),
    ...(internetMessageId === undefined ? {} : { internetMessageId }),
    ...(providerWebUrl === undefined ? {} : { providerWebUrl }),
    ...(subject === undefined ? {} : { subject }),
    ...(from === undefined ? {} : { from }),
    to,
  };
}

function normalizeMessage(message: GraphMessage, mailboxId: string): NormalizedEmail {
  const messageId = message.id ?? '';
  const conversationId = message.conversationId;
  const internetMessageId = message.internetMessageId;
  const from = normalizedAddress(message.from) ?? normalizedAddress(message.sender);
  const body = message.body ?? message.uniqueBody;
  const content = body?.content ?? undefined;
  const contentType = body?.contentType?.toLowerCase();
  const textBody = contentType === 'text' ? content : undefined;
  const htmlBody = contentType === 'html' ? content : undefined;
  const labels = [...(message.categories ?? [])];

  return {
    mailboxId,
    provider: 'microsoft',
    messageId,
    replyTo: normalizedAddresses(message.replyTo),
    to: normalizedAddresses(message.toRecipients),
    cc: normalizedAddresses(message.ccRecipients),
    subject: message.subject ?? '',
    isRead: message.isRead ?? false,
    isDraft: message.isDraft ?? false,
    hasAttachments: message.hasAttachments ?? false,
    folderIds: message.parentFolderId === undefined ? [] : [message.parentFolderId],
    labelIds: labels,
    references: [],
    ...(conversationId === undefined ? {} : { threadId: conversationId, conversationId }),
    ...(internetMessageId === undefined ? {} : { internetMessageId }),
    ...(from === undefined ? {} : { from }),
    ...(message.bodyPreview === undefined ? {} : { snippet: message.bodyPreview }),
    ...(textBody === undefined ? {} : { textBody }),
    ...(htmlBody === undefined ? {} : { htmlBody }),
    ...(message.receivedDateTime === undefined ? {} : { receivedAt: message.receivedDateTime }),
    ...(message.sentDateTime === undefined ? {} : { sentAt: message.sentDateTime }),
    ...(message.webLink === undefined ? {} : { providerWebUrl: message.webLink }),
  };
}

function messageTimestamp(message: NormalizedEmail): number {
  const value = message.receivedAt ?? message.sentAt;
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizeThread(
  graphMessages: GraphMessage[],
  mailboxId: string,
  threadId: string,
): NormalizedThread {
  const messages = graphMessages
    .map((message) => normalizeMessage(message, mailboxId))
    .sort((left, right) => messageTimestamp(left) - messageTimestamp(right));
  const participants: NormalizedEmailAddress[] = [];
  const seenAddresses = new Set<string>();

  for (const message of messages) {
    const addresses = [...(message.from ? [message.from] : []), ...message.to, ...message.cc];
    for (const address of addresses) {
      const key = address.address.trim().toLowerCase();
      if (key && !seenAddresses.has(key)) {
        seenAddresses.add(key);
        participants.push(address);
      }
    }
  }

  const newest = messages.at(-1);
  return {
    mailboxId,
    provider: 'microsoft',
    threadId,
    subject: newest?.subject ?? '',
    participants,
    messages,
    lastActivityAt: newest?.receivedAt ?? newest?.sentAt ?? new Date(0).toISOString(),
  };
}

function selectParameters(includeBody: boolean): URLSearchParams {
  return new URLSearchParams({ $select: (includeBody ? BODY_FIELDS : SUMMARY_FIELDS).join(',') });
}

function decodeCursor(cursor: string, correlationId: string): URL {
  let value: string;
  try {
    value = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch (error) {
    throw gatewayError(
      'INVALID_QUERY',
      'Invalid Microsoft pagination cursor',
      correlationId,
      false,
      {
        cause: error,
      },
    );
  }

  if (!value.startsWith(GRAPH_ORIGIN_PREFIX)) {
    throw gatewayError(
      'INVALID_QUERY',
      'Invalid Microsoft pagination cursor',
      correlationId,
      false,
    );
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com') throw new Error();
    return url;
  } catch (error) {
    throw gatewayError(
      'INVALID_QUERY',
      'Invalid Microsoft pagination cursor',
      correlationId,
      false,
      {
        cause: error,
      },
    );
  }
}

function encodeCursor(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

export function createMicrosoftAdapter(options: {
  mailboxId: string;
  emailAddress: string;
  aliases?: string[];
  correlationId: string;
  tokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
}): MailProviderAdapter & MailDraftAdapter {
  const adapterOptions: MicrosoftAdapterOptions = options;
  const fetchImpl = adapterOptions.fetchImpl ?? fetch;

  async function request<T>(url: URL, requestOptions: GraphRequestOptions = {}): Promise<T> {
    const { accessToken } = await adapterOptions.tokenProvider.getAccessToken(
      adapterOptions.mailboxId,
      adapterOptions.correlationId,
    );

    let response: Response;
    try {
      const hasBody = requestOptions.body !== undefined;
      response = await fetchImpl(url, {
        method: requestOptions.method ?? 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(requestOptions.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw gatewayError(
        isTimeoutError(error) ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        isTimeoutError(error)
          ? 'Microsoft Graph request timed out'
          : 'Microsoft Graph is unreachable',
        adapterOptions.correlationId,
        true,
        { cause: error },
      );
    }

    const payload = await readJson(response);
    if (!response.ok) {
      throw responseError(response, adapterOptions.correlationId, requestOptions.notFoundCode);
    }
    return payload as T;
  }

  function messageUrl(messageId: string): URL {
    return new URL(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}`);
  }

  function selectUrl(messageId: string, fields: readonly string[]): URL {
    const url = messageUrl(messageId);
    url.search = new URLSearchParams({ $select: fields.join(',') }).toString();
    return url;
  }

  function draftReadUrl(providerDraftId: string): URL {
    return selectUrl(providerDraftId, DRAFT_FIELDS);
  }

  async function readDraft(
    providerDraftId: string,
    readOptions: { includeBody?: boolean } = {},
  ): Promise<GraphMessage> {
    const url =
      readOptions.includeBody === true
        ? selectUrl(providerDraftId, [...DRAFT_FIELDS, 'body'])
        : draftReadUrl(providerDraftId);
    return request<GraphMessage>(url, { notFoundCode: 'DRAFT_NOT_FOUND' });
  }

  function requireDraft(message: GraphMessage): void {
    if (message.isDraft !== true) {
      throw gatewayError(
        'DRAFT_NOT_FOUND',
        'Microsoft draft not found',
        adapterOptions.correlationId,
        false,
      );
    }
  }

  return {
    mailboxId: adapterOptions.mailboxId,
    provider: 'microsoft',

    async verifyConnection() {
      await request<unknown>(new URL(`${GRAPH_API_BASE}/me/mailFolders/inbox`));
      return { status: 'ok', emailAddress: adapterOptions.emailAddress };
    },

    async searchEmails(query) {
      let url: URL;
      if (query.cursor) {
        url = decodeCursor(query.cursor, adapterOptions.correlationId);
      } else {
        url = new URL(`${GRAPH_API_BASE}${folderPath(query.folder)}`);
        const limit = Math.min(
          MAX_RESULT_LIMIT,
          Math.max(1, Math.trunc(query.limit ?? DEFAULT_RESULT_LIMIT)),
        );
        const parameters = selectParameters(false);
        parameters.set('$top', String(limit));
        const translation = translateGraphQuery(query);
        if (translation.mode === 'search') {
          parameters.set('$search', translation.search);
        } else {
          if (translation.filter !== undefined) parameters.set('$filter', translation.filter);
          parameters.set('$orderby', translation.orderby);
        }
        url.search = parameters.toString();
      }

      const result = await request<GraphMessageList>(url);
      const nextLink = result['@odata.nextLink'];
      return {
        items: (result.value ?? []).map((message) =>
          normalizeMessage(message, adapterOptions.mailboxId),
        ),
        ...(nextLink === undefined ? {} : { nextCursor: encodeCursor(nextLink) }),
      };
    },

    async getEmail(messageId, readOptions) {
      const parameters = selectParameters(readOptions?.includeBody !== false);
      const url = new URL(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}`);
      url.search = parameters.toString();
      const message = await request<GraphMessage>(url, { notFoundCode: 'MESSAGE_NOT_FOUND' });
      return normalizeMessage(message, adapterOptions.mailboxId);
    },

    async getThread(threadId) {
      const parameters = selectParameters(true);
      parameters.set('$filter', `conversationId eq ${quoteODataString(threadId)}`);
      parameters.set('$orderby', 'receivedDateTime asc');
      parameters.set('$top', '100');
      const url = new URL(`${GRAPH_API_BASE}/me/messages`);
      url.search = parameters.toString();
      const result = await request<GraphMessageList>(url, { notFoundCode: 'THREAD_NOT_FOUND' });
      if ((result.value?.length ?? 0) === 0) {
        throw gatewayError(
          'THREAD_NOT_FOUND',
          'Microsoft thread not found',
          adapterOptions.correlationId,
          false,
        );
      }
      return normalizeThread(result.value ?? [], adapterOptions.mailboxId, threadId);
    },

    async createDraft(input: ProviderDraftInput) {
      const message = await request<GraphMessage>(new URL(`${GRAPH_API_BASE}/me/messages`), {
        method: 'POST',
        body: {
          subject: input.subject,
          body: graphDraftBody(input),
          toRecipients: graphRecipients(input.to),
          ...(input.from === undefined
            ? {}
            : { from: graphFrom(input.from, input.fromDisplayName) }),
          ...(input.cc === undefined ? {} : { ccRecipients: graphRecipients(input.cc) }),
          ...(input.replyTo === undefined ? {} : { replyTo: graphRecipients([input.replyTo]) }),
        },
      });
      return draftSnapshot(message);
    },

    async createReplyDraft(input: ProviderReplyDraftInput) {
      const action = input.replyMode === 'replyAll' ? 'createReplyAll' : 'createReply';
      const url = new URL(
        `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(input.sourceMessageId)}/${action}`,
      );
      const created = await request<GraphMessage>(url, {
        method: 'POST',
        notFoundCode: 'MESSAGE_NOT_FOUND',
      });

      const hasBody = input.textBody !== undefined || input.htmlBody !== undefined;
      if (!hasBody && input.from === undefined) {
        return draftSnapshot(created);
      }

      const draftId = created.id ?? '';
      let body: { contentType: 'HTML' | 'Text'; content: string } | undefined;
      if (hasBody && input.quoteOriginal === false) {
        body = graphDraftBody(input);
      } else if (hasBody) {
        // Graph already composed the quoted conversation (with its own
        // From/Sent/To header block), so the new body goes on top of it the
        // way Outlook does, instead of re-quoting the original here. The new
        // body sits in a marked container so updateDraft can replace it
        // later without losing that quote, which Graph cannot compose again.
        const graphBody =
          created.body ??
          (
            await request<GraphMessage>(selectUrl(draftId, ['body']), {
              notFoundCode: 'DRAFT_NOT_FOUND',
            })
          ).body;
        body = {
          contentType: 'HTML',
          content: replyDraftHtml(newBodyHtml(input), graphBodyHtml(graphBody)),
        };
      }

      const updated = await request<GraphMessage>(messageUrl(draftId), {
        method: 'PATCH',
        body: {
          ...(body === undefined ? {} : { body }),
          ...(input.from === undefined
            ? {}
            : { from: graphFrom(input.from, input.fromDisplayName) }),
        },
        notFoundCode: 'DRAFT_NOT_FOUND',
      });
      return draftSnapshot({ ...created, ...updated });
    },

    async updateDraft(providerDraftId: string, update: ProviderDraftUpdate) {
      const replacesBody = update.textBody !== undefined || update.htmlBody !== undefined;
      const keepsQuote = replacesBody && update.quoteOriginalMessageId !== undefined;
      const current = await readDraft(providerDraftId, { includeBody: keepsQuote });
      requireDraft(current);

      let body: { contentType: 'HTML' | 'Text'; content: string } | undefined;
      let quoteRebuilt = false;
      const preserved = keepsQuote
        ? replaceReplyBody(current.body, newBodyHtml(update))
        : undefined;
      if (preserved !== undefined) {
        // The quote Graph composed at creation (full conversation, Outlook
        // header block) stays as it is; only the gateway's own part changes.
        body = { contentType: 'HTML', content: preserved };
      } else if (keepsQuote && update.quoteOriginalMessageId !== undefined) {
        // No container to replace: the draft predates the marker or was
        // rewritten in Outlook. There is no Graph action to compose the quote
        // again, so the source message is quoted here, Gmail-style, and the
        // caller is told the older history and Outlook layout are gone.
        quoteRebuilt = true;
        const source = await request<GraphMessage>(
          selectUrl(update.quoteOriginalMessageId, QUOTE_SOURCE_FIELDS),
          { notFoundCode: 'MESSAGE_NOT_FOUND' },
        );
        const from = normalizedAddress(source.from);
        const sentAt = source.sentDateTime ?? source.receivedDateTime;
        const sourceContent = source.body?.content ?? undefined;
        const sourceIsText = source.body?.contentType?.toLowerCase() === 'text';
        const quoted = appendQuotedOriginal(
          // Graph stores one body and it is HTML here, so the text form stays empty.
          { text: '', html: newBodyHtml(update) },
          {
            ...(from === undefined ? {} : { from }),
            ...(sentAt === undefined ? {} : { sentAt }),
            ...(sourceContent === undefined
              ? {}
              : sourceIsText
                ? { textBody: sourceContent }
                : { htmlBody: sourceContent }),
          },
          update.quoteTimeZone === undefined ? {} : { timeZone: update.quoteTimeZone },
        );
        body = { contentType: 'HTML', content: quoted.html };
      } else if (replacesBody) {
        body = graphDraftBody(update);
      }

      const updated = await request<GraphMessage>(messageUrl(providerDraftId), {
        method: 'PATCH',
        body: {
          ...(update.subject === undefined ? {} : { subject: update.subject }),
          ...(update.to === undefined ? {} : { toRecipients: graphRecipients(update.to) }),
          ...(update.from === undefined
            ? {}
            : { from: graphFrom(update.from, update.fromDisplayName) }),
          ...(body === undefined ? {} : { body }),
        },
        notFoundCode: 'DRAFT_NOT_FOUND',
      });
      const snapshot = draftSnapshot({ ...current, ...updated });
      return quoteRebuilt ? { ...snapshot, quoteRebuilt } : snapshot;
    },

    async getDraft(providerDraftId: string) {
      const message = await readDraft(providerDraftId);
      requireDraft(message);
      return draftSnapshot(message);
    },

    async getDraftByMessageId(providerMessageId: string) {
      const message = await readDraft(providerMessageId);
      requireDraft(message);
      return draftSnapshot(message);
    },

    async sendDraft(providerDraftId: string): Promise<ProviderSendReceipt> {
      const message = await readDraft(providerDraftId);
      requireDraft(message);
      await request<unknown>(new URL(`${messageUrl(providerDraftId).toString()}/send`), {
        method: 'POST',
        notFoundCode: 'DRAFT_NOT_FOUND',
      });
      // Graph answers 202 without the id of the item created in Sent Items.
      // The draft id may change when the message moves, so do not persist it
      // as though it were the sent-item id.
      return {
        ...(message.conversationId === undefined
          ? {}
          : { threadId: message.conversationId, conversationId: message.conversationId }),
        ...(message.internetMessageId === undefined
          ? {}
          : { internetMessageId: message.internetMessageId }),
      };
    },

    async deleteDraft(providerDraftId: string) {
      const message = await readDraft(providerDraftId);
      requireDraft(message);
      await request<unknown>(messageUrl(providerDraftId), {
        method: 'DELETE',
        notFoundCode: 'DRAFT_NOT_FOUND',
      });
    },
  };
}
