import {
  appendQuotedOriginal,
  GatewayError,
  parseAddressHeader,
  parseHeaderDateIso,
  parseReferences,
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
  type ProviderSendingIdentity,
} from '@yempik/core';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_WEB_BASE = 'https://mail.google.com/mail/u/0/#all';
const GMAIL_DRAFT_WEB_BASE = 'https://mail.google.com/mail/u/0/#drafts';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;

const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Reply-To',
  'Subject',
  'Date',
  'Message-ID',
  'In-Reply-To',
  'References',
] as const;

interface GmailAdapterOptions {
  mailboxId: string;
  emailAddress: string;
  aliases?: string[];
  correlationId: string;
  tokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailBody {
  attachmentId?: string;
  data?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  raw?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

interface GmailMessageList {
  messages?: { id?: string; threadId?: string }[];
  nextPageToken?: string;
}

interface GmailThread {
  id?: string;
  messages?: GmailMessage[];
}

interface GmailDraft {
  id?: string;
  message?: GmailMessage;
}

interface GmailDraftList {
  drafts?: GmailDraft[];
  nextPageToken?: string;
}

interface GmailSendAs {
  sendAsEmail?: string;
  displayName?: string;
  signature?: string;
  isPrimary?: boolean;
}

interface GmailSendAsList {
  sendAs?: GmailSendAs[];
}

type NotFoundCode = Extract<
  GatewayErrorCode,
  'MESSAGE_NOT_FOUND' | 'THREAD_NOT_FOUND' | 'DRAFT_NOT_FOUND'
>;

interface MimeMessageOptions {
  to: string[];
  cc?: string[];
  from?: string;
  /** Display name paired with `from`; ignored without `from`. */
  fromDisplayName?: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
}

function crlf(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, '\r\n');
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/u.test(value);
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function mimeSubject(subject: string): string {
  return isPrintableAscii(subject) ? subject : encodedWord(subject);
}

/**
 * Formats a From header value. An ASCII name is sent as an RFC 5322 quoted
 * string so commas, dots and parentheses in it cannot be read as address
 * syntax; anything else becomes an RFC 2047 encoded word, which must stand
 * outside quotes to be decoded. Whitespace runs (CR/LF included) collapse to
 * one space so a name can never inject another header line.
 */
function mimeFromHeader(address: string, displayName: string | undefined): string {
  const name = displayName?.replace(/\s+/gu, ' ').trim();
  if (!name) return address;
  const phrase = isPrintableAscii(name)
    ? `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : encodedWord(name);
  return `${phrase} <${address}>`;
}

/**
 * Re-emits a From header read back from Gmail. Gmail may hand the display name
 * back decoded, so a non-ASCII value is parsed and re-encoded instead of being
 * written raw into the rebuilt message.
 */
function existingFrom(value: string): { from: string; fromDisplayName?: string } {
  if (isPrintableAscii(value)) return { from: value };
  const parsed = parseAddressHeader(value)[0];
  if (parsed === undefined) return { from: value };
  return {
    from: parsed.address,
    ...(parsed.name === undefined ? {} : { fromDisplayName: parsed.name }),
  };
}

const QP_MAX_LINE = 76;

function quotedPrintableLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  let output = '';
  let current = '';
  for (const [index, byte] of bytes.entries()) {
    const isLast = index === bytes.length - 1;
    // Space and tab stay literal except at the end of a line, where transports
    // may strip them; '=' is always escaped because it introduces an escape.
    const literal =
      (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !isLast);
    const token = literal
      ? String.fromCharCode(byte)
      : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    // A soft break ("=" + CRLF) keeps every encoded line within 76 characters
    // and never splits an =XX escape.
    if (current.length + token.length > QP_MAX_LINE - 1) {
      output += `${current}=\r\n`;
      current = '';
    }
    current += token;
  }
  return output + current;
}

/**
 * RFC 2045 quoted-printable encoding of a UTF-8 body. Hard line breaks stay
 * CRLF; long lines get soft breaks, so a paragraph written on a single line
 * can no longer exceed the 998-character SMTP line limit that 8bit allowed.
 */
export function encodeQuotedPrintable(value: string): string {
  return crlf(value).split('\r\n').map(quotedPrintableLine).join('\r\n');
}

function alternativeBoundary(textBody: string, htmlBody: string): string {
  const seed = Buffer.from(`${textBody}\0${htmlBody}`, 'utf8').toString('base64url').slice(0, 32);
  return `yempik-alternative-${seed || 'empty'}`;
}

/** Builds a deterministic UTF-8 MIME message without performing I/O. */
export function buildMimeMessage(options: MimeMessageOptions): string {
  const headers = [
    ...(options.from === undefined
      ? []
      : [`From: ${mimeFromHeader(options.from, options.fromDisplayName)}`]),
    `To: ${options.to.join(', ')}`,
  ];
  if (options.cc && options.cc.length > 0) headers.push(`Cc: ${options.cc.join(', ')}`);
  if (options.replyTo) headers.push(`Reply-To: ${options.replyTo}`);
  headers.push(`Subject: ${mimeSubject(options.subject)}`);
  if (options.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references && options.references.length > 0) {
    headers.push(`References: ${options.references.join(' ')}`);
  }
  headers.push('MIME-Version: 1.0');

  const hasText = options.textBody !== undefined;
  const hasHtml = options.htmlBody !== undefined;
  if (hasText && hasHtml) {
    const textBody = encodeQuotedPrintable(options.textBody ?? '');
    const htmlBody = encodeQuotedPrintable(options.htmlBody ?? '');
    const boundary = alternativeBoundary(textBody, htmlBody);
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      textBody,
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      htmlBody,
      `--${boundary}--`,
      '',
    ].join('\r\n');
  }

  const contentType = hasHtml ? 'text/html' : 'text/plain';
  const body = encodeQuotedPrintable(hasHtml ? (options.htmlBody ?? '') : (options.textBody ?? ''));
  return [
    ...headers,
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: quoted-printable',
    '',
    body,
  ].join('\r\n');
}

function formatGmailDate(value: string): string {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10).replaceAll('-', '/');
  }
  return value.slice(0, 10).replaceAll('-', '/');
}

function quoteGmailPhrase(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Translates a provider-neutral query without performing I/O or mutating the input. */
export function translateGmailQuery(query: NormalizedSearchQuery): string {
  const terms: string[] = [];

  if (query.from) terms.push(`from:${query.from}`);
  if (query.to) terms.push(`to:${query.to}`);
  if (query.subject) terms.push(`subject:${quoteGmailPhrase(query.subject)}`);
  if (query.unreadOnly) terms.push('is:unread');
  if (query.hasAttachment) terms.push('has:attachment');
  if (query.after) terms.push(`after:${formatGmailDate(query.after)}`);
  if (query.before) terms.push(`before:${formatGmailDate(query.before)}`);

  switch (query.folder) {
    case 'inbox':
      terms.push('in:inbox');
      break;
    case 'sent':
      terms.push('in:sent');
      break;
    case 'drafts':
      terms.push('in:drafts');
      break;
    case 'archive':
      terms.push('-in:inbox', '-in:sent', '-in:drafts', '-in:trash');
      break;
    case 'all':
    case undefined:
      break;
  }

  if (query.text) terms.push(query.text);
  return terms.join(' ');
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

function errorReasons(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const error = payload.error;
  if (!isRecord(error) || !Array.isArray(error.errors)) return [];
  return error.errors.flatMap((item) =>
    isRecord(item) && typeof item.reason === 'string' ? [item.reason] : [],
  );
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
  payload: unknown,
  correlationId: string,
  notFoundCode?: NotFoundCode,
): GatewayError {
  if (response.status === 401) {
    return gatewayError('TOKEN_EXPIRED', 'Gmail rejected the access token', correlationId, false);
  }

  const reasons = errorReasons(payload);
  const isRateLimit =
    response.status === 429 ||
    (response.status === 403 &&
      reasons.some((reason) =>
        [
          'rateLimitExceeded',
          'userRateLimitExceeded',
          'quotaExceeded',
          'dailyLimitExceeded',
        ].includes(reason),
      ));
  if (isRateLimit) {
    const retryAfter = retryAfterSeconds(response);
    return gatewayError(
      'PROVIDER_RATE_LIMIT',
      'Gmail rate limit exceeded',
      correlationId,
      true,
      retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter },
    );
  }

  if (response.status === 404 && notFoundCode) {
    const notFoundMessage = {
      MESSAGE_NOT_FOUND: 'Gmail message not found',
      THREAD_NOT_FOUND: 'Gmail thread not found',
      DRAFT_NOT_FOUND: 'Gmail draft not found',
    }[notFoundCode];
    return gatewayError(notFoundCode, notFoundMessage, correlationId, false);
  }

  if (response.status >= 500) {
    return gatewayError(
      'PROVIDER_UNAVAILABLE',
      'Gmail is temporarily unavailable',
      correlationId,
      true,
    );
  }

  if (response.status === 400) {
    return gatewayError('INVALID_QUERY', 'Gmail rejected the request', correlationId, false);
  }

  return gatewayError(
    response.status === 403 ? 'AUTH_REQUIRED' : 'PROVIDER_REJECTED',
    `Gmail request failed with status ${response.status}`,
    correlationId,
    false,
  );
}

function headersByName(payload: GmailMessagePart | undefined): Map<string, string> {
  const headers = new Map<string, string>();
  for (const header of payload?.headers ?? []) {
    if (header.name && header.value !== undefined) {
      headers.set(header.name.toLowerCase(), header.value);
    }
  }
  return headers;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
}

interface MimeContent {
  textBody?: string;
  htmlBody?: string;
  hasAttachments: boolean;
}

function readMimeContent(payload: GmailMessagePart | undefined): MimeContent {
  let textBody: string | undefined;
  let htmlBody: string | undefined;
  let hasAttachments = false;

  function visit(part: GmailMessagePart): void {
    if ((part.filename?.length ?? 0) > 0 || part.body?.attachmentId !== undefined) {
      hasAttachments = true;
    }
    if (part.body?.data) {
      if (part.mimeType?.toLowerCase() === 'text/plain' && textBody === undefined) {
        textBody = decodeBase64Url(part.body.data);
      }
      if (part.mimeType?.toLowerCase() === 'text/html' && htmlBody === undefined) {
        htmlBody = decodeBase64Url(part.body.data);
      }
    }
    for (const child of part.parts ?? []) visit(child);
  }

  if (payload) visit(payload);
  return {
    hasAttachments,
    ...(textBody === undefined ? {} : { textBody }),
    ...(htmlBody === undefined ? {} : { htmlBody }),
  };
}

function internalDateIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

interface DraftBodies {
  textBody?: string;
  htmlBody?: string;
}

/**
 * Appends the source message below the new body as a Gmail-style quote, the
 * way the Gmail web client composes a reply. `source` must be a `format=full`
 * message so both its headers and its bodies are present. Only the parts the
 * caller supplied are returned, so a text-only reply stays text-only.
 */
function quoteGmailOriginal(
  body: DraftBodies,
  source: GmailMessage,
  timeZone: string | undefined,
): DraftBodies {
  const headers = headersByName(source.payload);
  const mime = readMimeContent(source.payload);
  const from = parseAddressHeader(headers.get('from'))[0];
  const sentAt = parseHeaderDateIso(headers.get('date')) ?? internalDateIso(source.internalDate);
  const quoted = appendQuotedOriginal(
    { text: body.textBody ?? '', html: body.htmlBody ?? '' },
    {
      ...(from === undefined ? {} : { from }),
      ...(sentAt === undefined ? {} : { sentAt }),
      ...(mime.textBody === undefined ? {} : { textBody: mime.textBody }),
      ...(mime.htmlBody === undefined ? {} : { htmlBody: mime.htmlBody }),
    },
    timeZone === undefined ? {} : { timeZone },
  );
  return {
    ...(body.textBody === undefined ? {} : { textBody: quoted.text }),
    ...(body.htmlBody === undefined ? {} : { htmlBody: quoted.html }),
  };
}

function normalizeMessage(message: GmailMessage, mailboxId: string): NormalizedEmail {
  const messageId = message.id ?? '';
  const headers = headersByName(message.payload);
  const labels = [...(message.labelIds ?? [])];
  const mime = readMimeContent(message.payload);
  const from = parseAddressHeader(headers.get('from'))[0];
  const receivedAt = internalDateIso(message.internalDate);
  const sentAt = parseHeaderDateIso(headers.get('date'));
  const internetMessageId = headers.get('message-id');
  const inReplyTo = headers.get('in-reply-to');

  return {
    mailboxId,
    provider: 'gmail',
    messageId,
    replyTo: parseAddressHeader(headers.get('reply-to')),
    to: parseAddressHeader(headers.get('to')),
    cc: parseAddressHeader(headers.get('cc')),
    subject: headers.get('subject') ?? '',
    isRead: !labels.includes('UNREAD'),
    isDraft: labels.includes('DRAFT'),
    hasAttachments: mime.hasAttachments,
    folderIds: [...labels],
    labelIds: labels,
    references: parseReferences(headers.get('references')),
    providerWebUrl: `${GMAIL_WEB_BASE}/${encodeURIComponent(messageId)}`,
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(internetMessageId === undefined ? {} : { internetMessageId }),
    ...(from === undefined ? {} : { from }),
    ...(message.snippet === undefined ? {} : { snippet: message.snippet }),
    ...(mime.textBody === undefined ? {} : { textBody: mime.textBody }),
    ...(mime.htmlBody === undefined ? {} : { htmlBody: mime.htmlBody }),
    ...(receivedAt === undefined ? {} : { receivedAt }),
    ...(sentAt === undefined ? {} : { sentAt }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  };
}

function messageTimestamp(message: NormalizedEmail): number {
  const value = message.receivedAt ?? message.sentAt;
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizeThread(
  thread: GmailThread,
  mailboxId: string,
  requestedId: string,
): NormalizedThread {
  const messages = (thread.messages ?? [])
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
    provider: 'gmail',
    threadId: thread.id ?? requestedId,
    subject: messages.find((message) => message.subject.length > 0)?.subject ?? '',
    participants,
    messages,
    lastActivityAt: newest?.receivedAt ?? newest?.sentAt ?? new Date(0).toISOString(),
  };
}

function metadataSearchParameters(): URLSearchParams {
  const parameters = new URLSearchParams({ format: 'metadata' });
  for (const header of METADATA_HEADERS) parameters.append('metadataHeaders', header);
  return parameters;
}

function encodeRawMime(message: string): string {
  return Buffer.from(message, 'utf8').toString('base64url');
}

function decodeRawMime(message: string): string {
  return Buffer.from(message, 'base64url').toString('utf8');
}

function rawHeadersByName(message: string): Map<string, string> {
  const normalized = crlf(message);
  const headers = new Map<string, string>();
  const separator = normalized.indexOf('\r\n\r\n');
  if (separator < 0) return headers;
  const headerSection = normalized.slice(0, separator);
  for (const block of headerSection.split(/\r\n(?=[^ \t])/u)) {
    const separator = block.indexOf(':');
    if (separator <= 0) continue;
    const name = block.slice(0, separator).toLowerCase();
    const value = block
      .slice(separator + 1)
      .replace(/\r\n[ \t]+/gu, ' ')
      .trim();
    headers.set(name, value);
  }
  return headers;
}

/** Rewrites only selected headers while preserving the existing MIME body and attachments. */
function replaceRawMimeHeaders(message: string, replacements: ReadonlyMap<string, string>): string {
  const normalized = crlf(message);
  const separator = normalized.indexOf('\r\n\r\n');
  if (separator < 0) return normalized;
  const blocks = normalized.slice(0, separator).split(/\r\n(?=[^ \t])/u);
  const replaced = new Set<string>();
  const headers = blocks.map((block) => {
    const colon = block.indexOf(':');
    if (colon <= 0) return block;
    const key = block.slice(0, colon).toLowerCase();
    const replacement = replacements.get(key);
    if (replacement === undefined) return block;
    replaced.add(key);
    return replacement;
  });
  for (const [key, replacement] of replacements) {
    if (!replaced.has(key)) headers.push(replacement);
  }
  return `${headers.join('\r\n')}${normalized.slice(separator)}`;
}

function draftSnapshot(
  draft: GmailDraft,
  requestedId: string,
  fallback: { subject?: string; to?: string[]; threadId?: string } = {},
): ProviderDraftSnapshot {
  const message = draft.message;
  const headers = headersByName(message?.payload);
  const messageId = message?.id;
  const threadId = message?.threadId ?? fallback.threadId;
  const internetMessageId = headers.get('message-id');
  const subject = headers.get('subject') ?? fallback.subject;
  const from = parseAddressHeader(headers.get('from'))[0]?.address;
  const parsedTo = parseAddressHeader(headers.get('to')).map((address) => address.address);
  const to = parsedTo.length > 0 ? parsedTo : fallback.to;

  return {
    providerDraftId: draft.id ?? requestedId,
    ...(messageId === undefined ? {} : { providerMessageId: messageId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(internetMessageId === undefined ? {} : { internetMessageId }),
    ...(messageId === undefined
      ? {}
      : { providerWebUrl: `${GMAIL_DRAFT_WEB_BASE}/${encodeURIComponent(messageId)}` }),
    ...(subject === undefined ? {} : { subject }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function uniqueAddresses(
  addresses: NormalizedEmailAddress[],
  excludedAddresses: readonly string[] = [],
): string[] {
  const unique: string[] = [];
  const seen = new Set(excludedAddresses.map((address) => address.trim().toLowerCase()));
  for (const address of addresses) {
    const key = address.address.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(address.address.trim());
    }
  }
  return unique;
}

export function createGmailAdapter(options: {
  mailboxId: string;
  emailAddress: string;
  aliases?: string[];
  correlationId: string;
  tokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
}): MailProviderAdapter &
  MailDraftAdapter &
  Required<Pick<MailProviderAdapter, 'listSendingIdentities'>> {
  const adapterOptions: GmailAdapterOptions = options;
  const fetchImpl = adapterOptions.fetchImpl ?? fetch;

  async function request<T>(
    pathname: string,
    requestOptions: {
      parameters?: URLSearchParams;
      notFoundCode?: NotFoundCode;
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
    } = {},
  ): Promise<T> {
    const { accessToken } = await adapterOptions.tokenProvider.getAccessToken(
      adapterOptions.mailboxId,
      adapterOptions.correlationId,
    );
    const url = new URL(`${GMAIL_API_BASE}${pathname}`);
    if (requestOptions.parameters) url.search = requestOptions.parameters.toString();

    const requestHeaders: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      ...(requestOptions.body === undefined ? {} : { 'content-type': 'application/json' }),
    };

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: requestOptions.method ?? 'GET',
        headers: requestHeaders,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
      });
    } catch (error) {
      throw gatewayError(
        isTimeoutError(error) ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        isTimeoutError(error) ? 'Gmail request timed out' : 'Gmail is unreachable',
        adapterOptions.correlationId,
        true,
        { cause: error },
      );
    }

    const payload = await readJson(response);
    if (!response.ok) {
      throw responseError(
        response,
        payload,
        adapterOptions.correlationId,
        requestOptions.notFoundCode,
      );
    }
    return payload as T;
  }

  async function getMessage(messageId: string, includeBody: boolean): Promise<NormalizedEmail> {
    const parameters = includeBody
      ? new URLSearchParams({ format: 'full' })
      : metadataSearchParameters();
    const message = await request<GmailMessage>(`/messages/${encodeURIComponent(messageId)}`, {
      parameters,
      notFoundCode: 'MESSAGE_NOT_FOUND',
    });
    return normalizeMessage(message, adapterOptions.mailboxId);
  }

  return {
    mailboxId: adapterOptions.mailboxId,
    provider: 'gmail',

    async verifyConnection() {
      const profile = await request<{ emailAddress?: string }>('/profile');
      return {
        status: 'ok',
        emailAddress: profile.emailAddress ?? adapterOptions.emailAddress,
      };
    },

    async searchEmails(query) {
      const limit = Math.min(
        MAX_RESULT_LIMIT,
        Math.max(1, Math.trunc(query.limit ?? DEFAULT_RESULT_LIMIT)),
      );
      const parameters = new URLSearchParams({
        q: translateGmailQuery(query),
        maxResults: String(limit),
      });
      if (query.cursor) parameters.set('pageToken', query.cursor);
      const result = await request<GmailMessageList>('/messages', { parameters });
      const items = await Promise.all(
        (result.messages ?? []).flatMap((message) =>
          message.id ? [getMessage(message.id, false)] : [],
        ),
      );
      return {
        items,
        ...(result.nextPageToken === undefined ? {} : { nextCursor: result.nextPageToken }),
      };
    },

    getEmail(messageId, readOptions) {
      return getMessage(messageId, readOptions?.includeBody === true);
    },

    async getThread(threadId) {
      const thread = await request<GmailThread>(`/threads/${encodeURIComponent(threadId)}`, {
        parameters: new URLSearchParams({ format: 'full' }),
        notFoundCode: 'THREAD_NOT_FOUND',
      });
      return normalizeThread(thread, adapterOptions.mailboxId, threadId);
    },

    // settings.sendAs.list is readable with the gmail.readonly scope the
    // mailbox already granted, so importing signatures needs no reconnection.
    async listSendingIdentities(): Promise<ProviderSendingIdentity[]> {
      const result = await request<GmailSendAsList>('/settings/sendAs');
      return (result.sendAs ?? []).flatMap((entry) => {
        const emailAddress = entry.sendAsEmail?.trim();
        if (!emailAddress) return [];
        const displayName = entry.displayName?.trim();
        // Gmail returns an empty string, not a missing field, when the
        // identity has no signature.
        const signatureHtml = entry.signature?.trim() ? entry.signature : undefined;
        return [
          {
            emailAddress,
            ...(displayName ? { displayName } : {}),
            ...(signatureHtml === undefined ? {} : { signatureHtml }),
            isPrimary: entry.isPrimary === true,
          },
        ];
      });
    },

    async createDraft(input: ProviderDraftInput) {
      const raw = encodeRawMime(buildMimeMessage(input));
      const draft = await request<GmailDraft>('/drafts', {
        method: 'POST',
        body: { message: { raw } },
      });
      return draftSnapshot(draft, '', { subject: input.subject, to: input.to });
    },

    async createReplyDraft(input: ProviderReplyDraftInput) {
      const suppliedBody: DraftBodies = {
        ...(input.textBody === undefined ? {} : { textBody: input.textBody }),
        ...(input.htmlBody === undefined ? {} : { htmlBody: input.htmlBody }),
      };
      const quotes =
        input.quoteOriginal !== false &&
        (suppliedBody.textBody !== undefined || suppliedBody.htmlBody !== undefined);
      // One request either way: `full` carries the same headers as `metadata`
      // plus the bodies the quote needs.
      const source = await request<GmailMessage>(
        `/messages/${encodeURIComponent(input.sourceMessageId)}`,
        {
          parameters: quotes ? new URLSearchParams({ format: 'full' }) : metadataSearchParameters(),
          notFoundCode: 'MESSAGE_NOT_FOUND',
        },
      );
      const headers = headersByName(source.payload);
      const replyTargets = parseAddressHeader(headers.get('reply-to'));
      const fromTargets = parseAddressHeader(headers.get('from'));
      const primaryTargets = replyTargets.length > 0 ? replyTargets : fromTargets;
      const allTargets =
        input.replyMode === 'replyAll'
          ? [
              ...primaryTargets,
              ...parseAddressHeader(headers.get('to')),
              ...parseAddressHeader(headers.get('cc')),
            ]
          : primaryTargets;
      const to = uniqueAddresses(
        allTargets,
        input.replyMode === 'replyAll'
          ? [adapterOptions.emailAddress, ...(adapterOptions.aliases ?? [])]
          : [],
      );
      const sourceSubject = headers.get('subject') ?? '';
      const subject = /^re:/iu.test(sourceSubject) ? sourceSubject : `Re: ${sourceSubject}`;
      const sourceMessageId = headers.get('message-id');
      const references = [
        ...parseReferences(headers.get('references')),
        ...(sourceMessageId === undefined ? [] : [sourceMessageId]),
      ];
      const body = quotes
        ? quoteGmailOriginal(suppliedBody, source, input.quoteTimeZone)
        : suppliedBody;
      const mime = buildMimeMessage({
        to,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.fromDisplayName === undefined ? {} : { fromDisplayName: input.fromDisplayName }),
        subject,
        ...body,
        ...(sourceMessageId === undefined ? {} : { inReplyTo: sourceMessageId }),
        ...(references.length === 0 ? {} : { references }),
      });
      const raw = encodeRawMime(mime);
      const draft = await request<GmailDraft>('/drafts', {
        method: 'POST',
        body: {
          message: {
            raw,
            ...(source.threadId === undefined ? {} : { threadId: source.threadId }),
          },
        },
      });
      return draftSnapshot(draft, '', {
        subject,
        to,
        ...(source.threadId === undefined ? {} : { threadId: source.threadId }),
      });
    },

    async updateDraft(providerDraftId: string, update: ProviderDraftUpdate) {
      const pathname = `/drafts/${encodeURIComponent(providerDraftId)}`;
      const replacesBody = update.textBody !== undefined || update.htmlBody !== undefined;
      const current = await request<GmailDraft>(pathname, {
        parameters: new URLSearchParams({ format: replacesBody ? 'metadata' : 'raw' }),
        notFoundCode: 'DRAFT_NOT_FOUND',
      });
      const currentRaw = current.message?.raw;
      const headers = replacesBody
        ? headersByName(current.message?.payload)
        : rawHeadersByName(currentRaw === undefined ? '' : decodeRawMime(currentRaw));
      const currentTo = parseAddressHeader(headers.get('to')).map((address) => address.address);
      const cc = parseAddressHeader(headers.get('cc')).map((address) => address.address);
      const to = update.to ?? currentTo;
      const subject = update.subject ?? headers.get('subject') ?? '';
      const currentFrom = headers.get('from');
      const from =
        update.from === undefined
          ? currentFrom === undefined
            ? undefined
            : existingFrom(currentFrom)
          : {
              from: update.from,
              ...(update.fromDisplayName === undefined
                ? {}
                : { fromDisplayName: update.fromDisplayName }),
            };
      const references = parseReferences(headers.get('references'));
      if (!replacesBody && currentRaw === undefined) {
        throw gatewayError(
          'PROVIDER_UNAVAILABLE',
          'Gmail returned no raw content for the draft',
          adapterOptions.correlationId,
          true,
        );
      }
      const suppliedBody: DraftBodies = {
        ...(update.textBody === undefined ? {} : { textBody: update.textBody }),
        ...(update.htmlBody === undefined ? {} : { htmlBody: update.htmlBody }),
      };
      // A reply draft whose body is replaced would otherwise lose the quoted
      // conversation, so the original is fetched again and re-quoted.
      const body =
        replacesBody && update.quoteOriginalMessageId !== undefined
          ? quoteGmailOriginal(
              suppliedBody,
              await request<GmailMessage>(
                `/messages/${encodeURIComponent(update.quoteOriginalMessageId)}`,
                {
                  parameters: new URLSearchParams({ format: 'full' }),
                  notFoundCode: 'MESSAGE_NOT_FOUND',
                },
              ),
              update.quoteTimeZone,
            )
          : suppliedBody;
      const mime = replacesBody
        ? buildMimeMessage({
            to,
            ...(cc.length === 0 ? {} : { cc }),
            ...from,
            subject,
            ...body,
            ...(headers.get('reply-to') === undefined
              ? {}
              : { replyTo: headers.get('reply-to') ?? '' }),
            ...(headers.get('in-reply-to') === undefined
              ? {}
              : { inReplyTo: headers.get('in-reply-to') ?? '' }),
            ...(references.length === 0 ? {} : { references }),
          })
        : replaceRawMimeHeaders(
            decodeRawMime(currentRaw ?? ''),
            new Map([
              ...(update.to === undefined ? [] : [['to', `To: ${to.join(', ')}`] as const]),
              ...(update.from === undefined
                ? []
                : [
                    [
                      'from',
                      `From: ${mimeFromHeader(update.from, update.fromDisplayName)}`,
                    ] as const,
                  ]),
              ...(update.subject === undefined
                ? []
                : [['subject', `Subject: ${mimeSubject(subject)}`] as const]),
            ]),
          );
      const raw = encodeRawMime(mime);
      const threadId = current.message?.threadId;
      const draft = await request<GmailDraft>(pathname, {
        method: 'PUT',
        body: {
          message: {
            raw,
            ...(threadId === undefined ? {} : { threadId }),
          },
        },
        notFoundCode: 'DRAFT_NOT_FOUND',
      });
      return draftSnapshot(draft, providerDraftId, {
        subject,
        to,
        ...(threadId === undefined ? {} : { threadId }),
      });
    },

    async getDraft(providerDraftId: string) {
      const draft = await request<GmailDraft>(`/drafts/${encodeURIComponent(providerDraftId)}`, {
        parameters: new URLSearchParams({ format: 'metadata' }),
        notFoundCode: 'DRAFT_NOT_FOUND',
      });
      return draftSnapshot(draft, providerDraftId);
    },

    async getDraftByMessageId(providerMessageId: string) {
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const parameters = new URLSearchParams({ maxResults: '500' });
        if (pageToken !== undefined) parameters.set('pageToken', pageToken);
        const page = await request<GmailDraftList>('/drafts', { parameters });
        const match = (page.drafts ?? []).find((draft) => draft.message?.id === providerMessageId);
        if (match?.id !== undefined) {
          const draft = await request<GmailDraft>(`/drafts/${encodeURIComponent(match.id)}`, {
            parameters: new URLSearchParams({ format: 'metadata' }),
            notFoundCode: 'DRAFT_NOT_FOUND',
          });
          return draftSnapshot(draft, match.id);
        }
        pageToken = page.nextPageToken;
        if (pageToken !== undefined && seenTokens.has(pageToken)) break;
        if (pageToken !== undefined) seenTokens.add(pageToken);
      } while (pageToken !== undefined);

      throw gatewayError(
        'DRAFT_NOT_FOUND',
        'Gmail draft message not found',
        adapterOptions.correlationId,
        false,
      );
    },

    async sendDraft(providerDraftId: string): Promise<ProviderSendReceipt> {
      const message = await request<GmailMessage>('/drafts/send', {
        method: 'POST',
        body: { id: providerDraftId },
        notFoundCode: 'DRAFT_NOT_FOUND',
      });
      const headers = headersByName(message.payload);
      return {
        ...(message.id === undefined ? {} : { providerMessageId: message.id }),
        ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
        ...(headers.get('message-id') === undefined
          ? {}
          : { internetMessageId: headers.get('message-id') ?? '' }),
      };
    },

    async deleteDraft(providerDraftId: string) {
      await request<unknown>(`/drafts/${encodeURIComponent(providerDraftId)}`, {
        method: 'DELETE',
        notFoundCode: 'DRAFT_NOT_FOUND',
      });
    },
  };
}
