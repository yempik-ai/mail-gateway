import {
  appendQuotedOriginal,
  GatewayError,
  parseAddressHeader,
  parseHeaderDateIso,
  parseReferences,
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

/**
 * Zoho Mail adapter. Three provider traits shape everything below.
 *
 * 1. Message paths are folder-scoped: content, headers and delete all require
 *    the folder id alongside the message id. The normalized `messageId` is
 *    therefore a composite `folderId:messageId` ref (see `encodeMessageRef`).
 *    A message moved to another folder invalidates a previously handed-out ref.
 * 2. RFC 5322 headers are a separate request per message. `searchEmails` stays
 *    on the cheap list payload and leaves `internetMessageId`/`references`
 *    empty (the same posture the Microsoft adapter already takes), while
 *    `getEmail` and `createReplyDraft` hydrate them.
 * 3. There is no endpoint that edits a draft in place, so `updateDraft` writes
 *    a replacement draft and then removes the previous one. The draft service
 *    persists the returned `providerDraftId`, so the gateway-side draft id is
 *    unaffected.
 *
 * Zoho has no endpoint documented for delivering an existing Zoho Mail draft.
 * `sendDraft` therefore reads the gateway-owned draft, submits the same content
 * to the send endpoint, and best-effort removes the old provider draft.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 200;
const DRAFT_MODE = 'draft';

interface ZohoAdapterOptions {
  mailboxId: string;
  emailAddress: string;
  aliases?: string[];
  correlationId: string;
  tokenProvider: AccessTokenProvider;
  /** Region-specific mail host, e.g. `https://mail.zoho.eu`. */
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
}

interface ZohoEnvelope<T> {
  status?: { code?: number; description?: string };
  data?: T;
}

/** Message shape shared by the list, search and details endpoints. */
interface ZohoMessage {
  messageId?: string | number;
  folderId?: string | number;
  threadId?: string | number;
  subject?: string;
  summary?: string;
  fromAddress?: string;
  sender?: string;
  toAddress?: string;
  ccAddress?: string;
  mailFormat?: string;
  receivedTime?: string | number;
  sentDateInGMT?: string | number;
  hasAttachment?: string | number;
  status?: string | number;
}

interface ZohoFolder {
  folderId?: string | number;
  folderName?: string;
  folderType?: string;
}

interface ZohoAccount {
  accountId?: string | number;
  primaryEmailAddress?: string;
}

type NotFoundCode = Extract<
  GatewayErrorCode,
  'MESSAGE_NOT_FOUND' | 'THREAD_NOT_FOUND' | 'DRAFT_NOT_FOUND'
>;

type ZohoMethod = 'GET' | 'POST' | 'DELETE';

interface ZohoRequestOptions {
  method?: ZohoMethod;
  body?: unknown;
  notFoundCode?: NotFoundCode;
}

export interface ZohoMessageRef {
  folderId: string;
  messageId: string;
}

/** Joins the two identifiers Zoho needs into the single id the contract exposes. */
export function encodeMessageRef(ref: ZohoMessageRef): string {
  return `${ref.folderId}:${ref.messageId}`;
}

/**
 * Splits a composite ref. Zoho ids are numeric, so the first colon is an
 * unambiguous separator.
 */
export function parseMessageRef(value: string): ZohoMessageRef | undefined {
  const separator = value.indexOf(':');
  if (separator <= 0) return undefined;
  const folderId = value.slice(0, separator);
  const messageId = value.slice(separator + 1);
  if (!folderId || !messageId) return undefined;
  return { folderId, messageId };
}

function escapeSearchValue(value: string): string {
  // `::` separates conditions in Zoho's search grammar, so a literal colon pair
  // inside a user term would silently start a new condition.
  return value.replaceAll('::', ': :').trim();
}

/**
 * Builds Zoho's `searchKey`: `field:value` conditions joined by `::`, which
 * Zoho reads as AND. Returns undefined when the query has nothing the search
 * endpoint understands, so the caller falls back to the folder listing.
 */
export function translateZohoSearchKey(query: NormalizedSearchQuery): string | undefined {
  const conditions: string[] = [];
  if (query.text) conditions.push(`entire:${escapeSearchValue(query.text)}`);
  if (query.from) conditions.push(`from:${escapeSearchValue(query.from)}`);
  if (query.to) conditions.push(`to:${escapeSearchValue(query.to)}`);
  if (query.subject) conditions.push(`subject:${escapeSearchValue(query.subject)}`);
  if (query.hasAttachment === true) conditions.push('has:attachment');
  return conditions.length === 0 ? undefined : conditions.join('::');
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

const DETAIL_FIELD_MAX_LENGTH = 200;

function detailField(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  if (text.length === 0) return undefined;
  return text.length <= DETAIL_FIELD_MAX_LENGTH
    ? text
    : `${text.slice(0, DETAIL_FIELD_MAX_LENGTH)}…`;
}

/**
 * Builds the evidence every failed Zoho call carries: the HTTP status plus
 * whatever the error envelope (`{status: {description}, data: {errorCode,
 * moreInfo}}`) says about the refusal. Fields are trimmed, bounded and skipped
 * when absent, so a non-JSON body still yields `HTTP <status>`. Pure: the
 * caller passes the already-parsed payload.
 */
export function zohoErrorDetail(status: number, payload: unknown): string {
  const envelope = isRecord(payload) ? payload : {};
  const envelopeStatus = isRecord(envelope.status) ? envelope.status : {};
  const data = isRecord(envelope.data) ? envelope.data : {};
  return [
    `HTTP ${status}`,
    detailField(data.errorCode),
    detailField(envelopeStatus.description),
    detailField(data.moreInfo),
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');
}

/**
 * Maps a non-2xx Zoho response onto a gateway error. Every message ends with
 * the `zohoErrorDetail` evidence, which is the only trace of the provider's own
 * explanation. Only 5xx is retryable; any other unmapped status (a bare 404
 * included) is a definitive refusal, so it becomes `PROVIDER_REJECTED` rather
 * than the uncertain `PROVIDER_UNAVAILABLE`.
 */
function responseError(
  response: Response,
  payload: unknown,
  correlationId: string,
  notFoundCode?: NotFoundCode,
): GatewayError {
  const detail = zohoErrorDetail(response.status, payload);
  if (response.status === 401) {
    return gatewayError(
      'TOKEN_EXPIRED',
      `Zoho rejected the access token (${detail})`,
      correlationId,
      false,
    );
  }
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response);
    return gatewayError(
      'PROVIDER_RATE_LIMIT',
      `Zoho Mail rate limit exceeded (${detail})`,
      correlationId,
      true,
      retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter },
    );
  }
  if (response.status === 404 && notFoundCode) {
    const notFoundMessage = {
      MESSAGE_NOT_FOUND: 'Zoho message not found',
      THREAD_NOT_FOUND: 'Zoho thread not found',
      DRAFT_NOT_FOUND: 'Zoho draft not found',
    } as const;
    return gatewayError(
      notFoundCode,
      `${notFoundMessage[notFoundCode]} (${detail})`,
      correlationId,
      false,
    );
  }
  if (response.status >= 500) {
    return gatewayError(
      'PROVIDER_UNAVAILABLE',
      `Zoho Mail is temporarily unavailable (${detail})`,
      correlationId,
      true,
    );
  }
  if (response.status === 400) {
    return gatewayError(
      'INVALID_QUERY',
      `Zoho Mail rejected the request (${detail})`,
      correlationId,
      false,
    );
  }
  return gatewayError(
    response.status === 403 ? 'AUTH_REQUIRED' : 'PROVIDER_REJECTED',
    `Zoho Mail refused the request (${detail})`,
    correlationId,
    false,
  );
}

function asString(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  return text.length === 0 ? undefined : text;
}

function epochIso(value: string | number | undefined): string | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  const milliseconds = Number(text);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  return new Date(milliseconds).toISOString();
}

function zohoFlag(value: string | number | undefined): boolean {
  const text = asString(value);
  return text === '1' || text === 'true';
}

/**
 * Case-insensitive lookup over the `headerContent` map, which returns every
 * header as an array because headers may repeat.
 */
export function headerValue(headerContent: unknown, name: string): string | undefined {
  if (!isRecord(headerContent)) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headerContent)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) {
      for (const entry of value as unknown[]) {
        if (typeof entry === 'string' && entry.trim().length > 0) return entry.trim();
      }
      return undefined;
    }
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }
  return undefined;
}

/** Zoho writes this literal into address fields that carry no address. */
const ZOHO_ABSENT_FIELD = 'Not Provided';

const HTML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  quot: '"',
  amp: '&',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the HTML entities Zoho applies to text fields of list and details payloads. */
export function decodeZohoText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity: string, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return HTML_NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function zohoAddressField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const decoded = decodeZohoText(value).trim();
  return decoded.length === 0 || decoded === ZOHO_ABSENT_FIELD ? undefined : decoded;
}

const ZOHO_ADDRESS_FIELDS = ['fromAddress', 'sender', 'toAddress', 'ccAddress'] as const;
const ZOHO_TEXT_FIELDS = ['subject', 'summary'] as const;

/**
 * Restores the wire form of a Zoho message. Zoho HTML-escapes addresses,
 * subject and summary (`&lt;a@b&gt;`, `&quot;Name&quot;`) and writes the
 * literal `Not Provided` into empty address fields. Decoding once, where a
 * payload enters the adapter, keeps search results and the send path honest:
 * echoing `&lt;a@b&gt;` back as `toAddress` made Zoho refuse every delivery
 * with "Special characters present in recipients' address".
 */
export function decodeZohoMessage(message: ZohoMessage): ZohoMessage {
  const decoded: ZohoMessage = { ...message };
  for (const field of ZOHO_ADDRESS_FIELDS) {
    const value = zohoAddressField(message[field]);
    if (value === undefined) delete decoded[field];
    else decoded[field] = value;
  }
  for (const field of ZOHO_TEXT_FIELDS) {
    const value = message[field];
    if (value !== undefined) decoded[field] = decodeZohoText(value);
  }
  return decoded;
}

/** Normalizes a Zoho list/details entry. Body and RFC headers are layered on separately. */
export function normalizeZohoMessage(message: ZohoMessage, mailboxId: string): NormalizedEmail {
  const folderId = asString(message.folderId) ?? '';
  const rawMessageId = asString(message.messageId) ?? '';
  const threadId = asString(message.threadId);
  const from = parseAddressHeader(message.fromAddress ?? message.sender)[0];
  const receivedAt = epochIso(message.receivedTime);
  const sentAt = epochIso(message.sentDateInGMT);

  return {
    mailboxId,
    provider: 'zoho',
    messageId: encodeMessageRef({ folderId, messageId: rawMessageId }),
    replyTo: [],
    to: parseAddressHeader(message.toAddress),
    cc: parseAddressHeader(message.ccAddress),
    subject: message.subject ?? '',
    // Zoho marks a read message with status "1".
    isRead: zohoFlag(message.status),
    isDraft: false,
    hasAttachments: zohoFlag(message.hasAttachment),
    folderIds: folderId ? [folderId] : [],
    labelIds: [],
    references: [],
    ...(threadId === undefined ? {} : { threadId, conversationId: threadId }),
    ...(from === undefined ? {} : { from }),
    ...(message.summary === undefined ? {} : { snippet: message.summary }),
    ...(receivedAt === undefined ? {} : { receivedAt }),
    ...(sentAt === undefined ? {} : { sentAt }),
  };
}

function messageTimestamp(message: NormalizedEmail): number {
  const value = message.receivedAt ?? message.sentAt;
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizeThread(
  messages: NormalizedEmail[],
  mailboxId: string,
  threadId: string,
): NormalizedThread {
  const ordered = [...messages].sort(
    (left, right) => messageTimestamp(left) - messageTimestamp(right),
  );
  const participants: NormalizedEmailAddress[] = [];
  const seenAddresses = new Set<string>();

  for (const message of ordered) {
    const addresses = [...(message.from ? [message.from] : []), ...message.to, ...message.cc];
    for (const address of addresses) {
      const key = address.address.trim().toLowerCase();
      if (key && !seenAddresses.has(key)) {
        seenAddresses.add(key);
        participants.push(address);
      }
    }
  }

  const newest = ordered.at(-1);
  return {
    mailboxId,
    provider: 'zoho',
    threadId,
    subject: newest?.subject ?? '',
    participants,
    messages: ordered,
    lastActivityAt: newest?.receivedAt ?? newest?.sentAt ?? new Date(0).toISOString(),
  };
}

function decodeCursor(cursor: string, correlationId: string): number {
  const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(decoded) || decoded < 1) {
    throw gatewayError('INVALID_QUERY', 'Invalid Zoho pagination cursor', correlationId, false);
  }
  return decoded;
}

function encodeCursor(start: number): string {
  return Buffer.from(String(start), 'utf8').toString('base64url');
}

function replySubject(subject: string): string {
  return /^re:/iu.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

export function createZohoAdapter(
  options: ZohoAdapterOptions,
): MailProviderAdapter & MailDraftAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = `${options.apiBaseUrl.replace(/\/+$/u, '')}/api`;
  const ownAddresses = new Set(
    [options.emailAddress, ...(options.aliases ?? [])].map((address) =>
      address.trim().toLowerCase(),
    ),
  );

  let accountIdPromise: Promise<string> | undefined;
  let foldersPromise: Promise<ZohoFolder[]> | undefined;

  async function request<T>(url: URL, requestOptions: ZohoRequestOptions = {}): Promise<T> {
    const { accessToken } = await options.tokenProvider.getAccessToken(
      options.mailboxId,
      options.correlationId,
    );

    let response: Response;
    try {
      const hasBody = requestOptions.body !== undefined;
      response = await fetchImpl(url, {
        method: requestOptions.method ?? 'GET',
        headers: {
          authorization: `Zoho-oauthtoken ${accessToken}`,
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(requestOptions.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw gatewayError(
        isTimeoutError(error) ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        isTimeoutError(error) ? 'Zoho Mail request timed out' : 'Zoho Mail is unreachable',
        options.correlationId,
        true,
        { cause: error },
      );
    }

    const payload = await readJson(response);
    if (!response.ok) {
      throw responseError(response, payload, options.correlationId, requestOptions.notFoundCode);
    }
    return payload as T;
  }

  async function accountId(): Promise<string> {
    accountIdPromise ??= (async () => {
      const payload = await request<ZohoEnvelope<ZohoAccount[]>>(new URL(`${apiBase}/accounts`));
      const id = asString(payload.data?.[0]?.accountId);
      if (id === undefined) {
        throw gatewayError(
          'AUTH_REQUIRED',
          'Zoho returned no account for this token',
          options.correlationId,
          false,
        );
      }
      return id;
    })();
    return accountIdPromise;
  }

  async function folders(): Promise<ZohoFolder[]> {
    foldersPromise ??= (async () => {
      const payload = await request<ZohoEnvelope<ZohoFolder[]>>(
        new URL(`${apiBase}/accounts/${await accountId()}/folders`),
      );
      return payload.data ?? [];
    })();
    return foldersPromise;
  }

  /** Resolves a provider-neutral folder onto a Zoho folder id. */
  async function folderId(folder: NormalizedSearchQuery['folder']): Promise<string | undefined> {
    if (folder === undefined || folder === 'all') return undefined;
    const wanted = { inbox: 'inbox', sent: 'sent', drafts: 'drafts', archive: 'archive' }[folder];
    for (const entry of await folders()) {
      const type = entry.folderType?.trim().toLowerCase();
      const name = entry.folderName?.trim().toLowerCase();
      if (type === wanted || name === wanted) return asString(entry.folderId);
    }
    return undefined;
  }

  async function draftsFolderId(): Promise<string> {
    const id = await folderId('drafts');
    if (id === undefined) {
      throw gatewayError(
        'PROVIDER_UNAVAILABLE',
        'Zoho mailbox has no Drafts folder',
        options.correlationId,
        false,
      );
    }
    return id;
  }

  function requireRef(value: string, notFoundCode: NotFoundCode): ZohoMessageRef {
    const ref = parseMessageRef(value);
    if (!ref) {
      throw gatewayError(
        notFoundCode,
        `"${value}" is not a Zoho message reference (expected folderId:messageId)`,
        options.correlationId,
        false,
      );
    }
    return ref;
  }

  function messagePath(ref: ZohoMessageRef, account: string, suffix: string): URL {
    return new URL(
      `${apiBase}/accounts/${account}/folders/${encodeURIComponent(ref.folderId)}/messages/${encodeURIComponent(ref.messageId)}${suffix}`,
    );
  }

  async function readHeaders(
    ref: ZohoMessageRef,
    notFoundCode: NotFoundCode,
  ): Promise<Record<string, unknown>> {
    const url = messagePath(ref, await accountId(), '/header');
    url.searchParams.set('raw', 'false');
    const payload = await request<ZohoEnvelope<{ headerContent?: unknown }>>(url, { notFoundCode });
    const headerContent = payload.data?.headerContent;
    return isRecord(headerContent) ? headerContent : {};
  }

  async function readContent(ref: ZohoMessageRef): Promise<string | undefined> {
    const payload = await request<ZohoEnvelope<{ content?: string }>>(
      messagePath(ref, await accountId(), '/content'),
      { notFoundCode: 'MESSAGE_NOT_FOUND' },
    );
    return payload.data?.content;
  }

  async function readMessage(
    ref: ZohoMessageRef,
    notFoundCode: NotFoundCode,
  ): Promise<ZohoMessage> {
    const payload = await request<ZohoEnvelope<ZohoMessage>>(
      messagePath(ref, await accountId(), '/details'),
      { notFoundCode },
    );
    const message = payload.data;
    if (!message) {
      throw gatewayError(notFoundCode, 'Zoho message not found', options.correlationId, false);
    }
    // The details payload does not always echo the ids back.
    return decodeZohoMessage({ folderId: ref.folderId, messageId: ref.messageId, ...message });
  }

  async function listMessages(parameters: URLSearchParams): Promise<ZohoMessage[]> {
    const url = new URL(`${apiBase}/accounts/${await accountId()}/messages/view`);
    url.search = parameters.toString();
    const payload = await request<ZohoEnvelope<ZohoMessage[]>>(url);
    return (payload.data ?? []).map(decodeZohoMessage);
  }

  function draftBody(input: { textBody?: string; htmlBody?: string }): {
    content: string;
    mailFormat: 'html' | 'plaintext';
  } {
    // Zoho stores one representation. HTML wins when both are supplied.
    if (input.htmlBody !== undefined) return { content: input.htmlBody, mailFormat: 'html' };
    return { content: input.textBody ?? '', mailFormat: 'plaintext' };
  }

  /**
   * The new body followed by the quoted original, Gmail-style. Zoho's draft
   * endpoint composes no quote itself and stores a single representation, so
   * the result is always HTML: a text-only body is escaped into HTML first.
   * `sourceHeaders` are the original's headers, already read by the caller.
   */
  async function quotedDraftBody(
    body: { textBody?: string; htmlBody?: string },
    sourceRef: ZohoMessageRef,
    sourceHeaders: Record<string, unknown>,
    timeZone: string | undefined,
  ): Promise<{ content: string; mailFormat: 'html' }> {
    const original = await readContent(sourceRef);
    const from = parseAddressHeader(headerValue(sourceHeaders, 'from'))[0];
    const sentAt = parseHeaderDateIso(headerValue(sourceHeaders, 'date'));
    const quoted = appendQuotedOriginal(
      // Only the HTML form is posted, so the text form is left empty.
      { text: '', html: body.htmlBody ?? textToHtml(body.textBody ?? '') },
      {
        ...(from === undefined ? {} : { from }),
        ...(sentAt === undefined ? {} : { sentAt }),
        ...(original === undefined ? {} : { htmlBody: original }),
      },
      timeZone === undefined ? {} : { timeZone },
    );
    return { content: quoted.html, mailFormat: 'html' };
  }

  interface DraftPayload {
    to: string[];
    cc?: string[];
    from?: string;
    subject: string;
    content: string;
    mailFormat: 'html' | 'plaintext';
    replyTo?: string;
    inReplyTo?: string;
    references?: string[];
  }

  async function postDraft(payload: DraftPayload): Promise<ProviderDraftSnapshot> {
    const account = await accountId();
    const created = await request<ZohoEnvelope<ZohoMessage>>(
      new URL(`${apiBase}/accounts/${account}/messages`),
      {
        method: 'POST',
        body: {
          // Draft creation always pins the provider endpoint to draft mode.
          mode: DRAFT_MODE,
          // Zoho's draft API takes the bare address only and shows the name
          // configured for that address in Zoho, so `fromDisplayName` is not
          // sent anywhere on this provider.
          fromAddress: payload.from ?? options.emailAddress,
          toAddress: payload.to.join(','),
          subject: payload.subject,
          content: payload.content,
          mailFormat: payload.mailFormat,
          ...(payload.cc === undefined || payload.cc.length === 0
            ? {}
            : { ccAddress: payload.cc.join(',') }),
          ...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
          ...(payload.inReplyTo === undefined ? {} : { inReplyTo: payload.inReplyTo }),
          ...(payload.references === undefined || payload.references.length === 0
            ? {}
            : { refHeader: payload.references.join(' ') }),
        },
      },
    );

    const messageId = asString(created.data?.messageId);
    if (messageId === undefined) {
      throw gatewayError(
        'PROVIDER_UNAVAILABLE',
        'Zoho returned no message id for the created draft',
        options.correlationId,
        true,
      );
    }
    const draftFolder = asString(created.data?.folderId) ?? (await draftsFolderId());
    const ref = encodeMessageRef({ folderId: draftFolder, messageId });
    const threadId = asString(created.data?.threadId);

    return {
      providerDraftId: ref,
      providerMessageId: ref,
      ...(threadId === undefined ? {} : { threadId, conversationId: threadId }),
      ...(payload.inReplyTo === undefined ? {} : { internetMessageId: payload.inReplyTo }),
      subject: payload.subject,
      to: payload.to,
    };
  }

  async function requireDraftRef(providerDraftId: string): Promise<ZohoMessageRef> {
    const ref = requireRef(providerDraftId, 'DRAFT_NOT_FOUND');
    if (ref.folderId !== (await draftsFolderId())) {
      throw gatewayError(
        'DRAFT_NOT_FOUND',
        'Zoho message is not in the Drafts folder',
        options.correlationId,
        false,
      );
    }
    return ref;
  }

  async function deleteRef(ref: ZohoMessageRef): Promise<void> {
    await request<unknown>(messagePath(ref, await accountId(), ''), {
      method: 'DELETE',
      notFoundCode: 'DRAFT_NOT_FOUND',
    });
  }

  async function draftSnapshotOf(ref: ZohoMessageRef): Promise<ProviderDraftSnapshot> {
    const message = await readMessage(ref, 'DRAFT_NOT_FOUND');
    const headers = await readHeaders(ref, 'DRAFT_NOT_FOUND');
    const internetMessageId = headerValue(headers, 'message-id');
    const threadId = asString(message.threadId);
    const from =
      parseAddressHeader(message.fromAddress)[0]?.address ??
      parseAddressHeader(headerValue(headers, 'from'))[0]?.address;
    const encoded = encodeMessageRef(ref);

    return {
      providerDraftId: encoded,
      providerMessageId: encoded,
      ...(threadId === undefined ? {} : { threadId, conversationId: threadId }),
      ...(internetMessageId === undefined ? {} : { internetMessageId }),
      ...(message.subject === undefined ? {} : { subject: message.subject }),
      ...(from === undefined ? {} : { from }),
      to: parseAddressHeader(message.toAddress).map((address) => address.address),
    };
  }

  return {
    mailboxId: options.mailboxId,
    provider: 'zoho',

    async verifyConnection() {
      await accountId();
      return { status: 'ok', emailAddress: options.emailAddress };
    },

    async searchEmails(query) {
      const limit = Math.min(
        MAX_RESULT_LIMIT,
        Math.max(1, Math.trunc(query.limit ?? DEFAULT_RESULT_LIMIT)),
      );
      const start = query.cursor ? decodeCursor(query.cursor, options.correlationId) : 1;
      const searchKey = translateZohoSearchKey(query);
      const folder = await folderId(query.folder);

      const parameters = new URLSearchParams({
        start: String(start),
        limit: String(limit),
        includeto: 'true',
      });
      if (folder !== undefined) parameters.set('folderId', folder);

      let raw: ZohoMessage[];
      if (searchKey === undefined) {
        // `status=unread` is only available on the folder listing.
        if (query.unreadOnly) parameters.set('status', 'unread');
        raw = await listMessages(parameters);
      } else {
        const url = new URL(`${apiBase}/accounts/${await accountId()}/messages/search`);
        parameters.set('searchKey', searchKey);
        // The search endpoint takes an upper time bound only.
        if (query.before) {
          const before = Date.parse(query.before);
          if (!Number.isNaN(before)) parameters.set('receivedTime', String(before));
        }
        url.search = parameters.toString();
        const payload = await request<ZohoEnvelope<ZohoMessage[]>>(url);
        raw = (payload.data ?? []).map(decodeZohoMessage);
      }

      let items = raw.map((message) => normalizeZohoMessage(message, options.mailboxId));

      // Zoho filters neither bound on the listing endpoint and only the upper
      // bound on search, so the remaining date narrowing happens here. It
      // applies within the fetched page: a caller paginating a date-bounded
      // query may see short pages.
      const after = query.after ? Date.parse(query.after) : Number.NaN;
      const before = query.before ? Date.parse(query.before) : Number.NaN;
      if (!Number.isNaN(after)) items = items.filter((item) => messageTimestamp(item) >= after);
      if (!Number.isNaN(before)) items = items.filter((item) => messageTimestamp(item) < before);
      if (query.unreadOnly && searchKey !== undefined) items = items.filter((item) => !item.isRead);

      return {
        items,
        ...(raw.length < limit ? {} : { nextCursor: encodeCursor(start + limit) }),
      };
    },

    async getEmail(messageId, readOptions) {
      const ref = requireRef(messageId, 'MESSAGE_NOT_FOUND');
      const message = await readMessage(ref, 'MESSAGE_NOT_FOUND');
      const normalized = normalizeZohoMessage(message, options.mailboxId);
      const headers = await readHeaders(ref, 'MESSAGE_NOT_FOUND');

      const internetMessageId = headerValue(headers, 'message-id');
      const inReplyTo = headerValue(headers, 'in-reply-to');
      const replyTo = parseAddressHeader(headerValue(headers, 'reply-to'));
      const references = parseReferences(headerValue(headers, 'references'));
      const htmlBody =
        readOptions?.includeBody === false ? undefined : ((await readContent(ref)) ?? undefined);

      return {
        ...normalized,
        replyTo,
        references,
        ...(internetMessageId === undefined ? {} : { internetMessageId }),
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
        ...(htmlBody === undefined ? {} : { htmlBody }),
      };
    },

    async getThread(threadId) {
      const raw = await listMessages(
        new URLSearchParams({
          threadId,
          limit: String(MAX_RESULT_LIMIT),
          start: '1',
          includeto: 'true',
        }),
      );
      if (raw.length === 0) {
        throw gatewayError(
          'THREAD_NOT_FOUND',
          'Zoho thread not found',
          options.correlationId,
          false,
        );
      }
      return normalizeThread(
        raw.map((message) => normalizeZohoMessage(message, options.mailboxId)),
        options.mailboxId,
        threadId,
      );
    },

    async createDraft(input: ProviderDraftInput) {
      return postDraft({
        to: input.to,
        ...(input.from === undefined ? {} : { from: input.from }),
        subject: input.subject,
        ...draftBody(input),
        ...(input.cc === undefined ? {} : { cc: input.cc }),
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      });
    },

    async createReplyDraft(input: ProviderReplyDraftInput) {
      const ref = requireRef(input.sourceMessageId, 'MESSAGE_NOT_FOUND');
      const headers = await readHeaders(ref, 'MESSAGE_NOT_FOUND');

      const sourceMessageId = headerValue(headers, 'message-id');
      const sourceReferences = parseReferences(headerValue(headers, 'references'));
      const replyTargets = parseAddressHeader(headerValue(headers, 'reply-to'));
      const fromTargets = parseAddressHeader(headerValue(headers, 'from'));
      const primary = replyTargets.length > 0 ? replyTargets : fromTargets;

      const everyone =
        input.replyMode === 'replyAll'
          ? [
              ...primary,
              ...parseAddressHeader(headerValue(headers, 'to')),
              ...parseAddressHeader(headerValue(headers, 'cc')),
            ]
          : primary;

      const recipients: string[] = [];
      const seen = new Set<string>(ownAddresses);
      for (const entry of everyone) {
        const key = entry.address.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        recipients.push(entry.address);
      }
      if (recipients.length === 0) {
        throw gatewayError(
          'MESSAGE_NOT_FOUND',
          'Zoho source message carries no reply recipient',
          options.correlationId,
          false,
        );
      }

      const quotes =
        input.quoteOriginal !== false &&
        (input.textBody !== undefined || input.htmlBody !== undefined);
      return postDraft({
        to: recipients,
        ...(input.from === undefined ? {} : { from: input.from }),
        subject: replySubject(headerValue(headers, 'subject') ?? ''),
        ...(quotes
          ? await quotedDraftBody(input, ref, headers, input.quoteTimeZone)
          : draftBody(input)),
        ...(sourceMessageId === undefined
          ? {}
          : {
              inReplyTo: sourceMessageId,
              references: [...sourceReferences, sourceMessageId],
            }),
      });
    },

    async updateDraft(providerDraftId: string, update: ProviderDraftUpdate) {
      const ref = await requireDraftRef(providerDraftId);
      const current = await readMessage(ref, 'DRAFT_NOT_FOUND');
      const headers = await readHeaders(ref, 'DRAFT_NOT_FOUND');

      const to =
        update.to ?? parseAddressHeader(current.toAddress).map((address) => address.address);
      let body: { content: string; mailFormat: 'html' | 'plaintext' };
      if (update.textBody === undefined && update.htmlBody === undefined) {
        body = { content: (await readContent(ref)) ?? '', mailFormat: 'html' };
      } else if (update.quoteOriginalMessageId !== undefined) {
        // The replacement draft would otherwise carry only the new body and
        // drop the conversation history, so the original is quoted again.
        const sourceRef = requireRef(update.quoteOriginalMessageId, 'MESSAGE_NOT_FOUND');
        body = await quotedDraftBody(
          update,
          sourceRef,
          await readHeaders(sourceRef, 'MESSAGE_NOT_FOUND'),
          update.quoteTimeZone,
        );
      } else {
        body = draftBody(update);
      }

      const cc = parseAddressHeader(current.ccAddress).map((address) => address.address);
      const inReplyTo = headerValue(headers, 'in-reply-to');

      // Zoho cannot edit a draft in place. The replacement is written before
      // the previous draft is removed, so a failure here leaves the original
      // intact rather than losing the content.
      const replacement = await postDraft({
        to,
        ...(update.from === undefined
          ? current.fromAddress === undefined
            ? {}
            : { from: current.fromAddress }
          : { from: update.from }),
        subject: update.subject ?? current.subject ?? '',
        ...body,
        ...(cc.length === 0 ? {} : { cc }),
        ...(inReplyTo === undefined
          ? {}
          : { inReplyTo, references: parseReferences(headerValue(headers, 'references')) }),
      });
      await deleteRef(ref);
      return replacement;
    },

    async getDraft(providerDraftId: string) {
      return draftSnapshotOf(await requireDraftRef(providerDraftId));
    },

    async getDraftByMessageId(providerMessageId: string) {
      return draftSnapshotOf(await requireDraftRef(providerMessageId));
    },

    async sendDraft(providerDraftId: string): Promise<ProviderSendReceipt> {
      const ref = await requireDraftRef(providerDraftId);
      const [message, headers, content] = await Promise.all([
        readMessage(ref, 'DRAFT_NOT_FOUND'),
        readHeaders(ref, 'DRAFT_NOT_FOUND'),
        readContent(ref),
      ]);
      const to = parseAddressHeader(message.toAddress).map((entry) => entry.address);
      if (to.length === 0) {
        throw gatewayError(
          'INVALID_RECIPIENT',
          'Zoho draft has no valid recipient',
          options.correlationId,
          false,
        );
      }
      const from =
        parseAddressHeader(message.fromAddress)[0]?.address ??
        parseAddressHeader(headerValue(headers, 'from'))[0]?.address ??
        options.emailAddress;
      const cc = parseAddressHeader(message.ccAddress).map((entry) => entry.address);
      const inReplyTo = headerValue(headers, 'in-reply-to');
      const references = parseReferences(headerValue(headers, 'references'));
      const sent = await request<ZohoEnvelope<ZohoMessage>>(
        new URL(`${apiBase}/accounts/${await accountId()}/messages`),
        {
          method: 'POST',
          body: {
            fromAddress: from,
            toAddress: to.join(','),
            ...(cc.length === 0 ? {} : { ccAddress: cc.join(',') }),
            subject: message.subject ?? '',
            content: content ?? '',
            mailFormat: message.mailFormat?.toLowerCase() === 'plaintext' ? 'plaintext' : 'html',
            ...(inReplyTo === undefined ? {} : { inReplyTo }),
            ...(references.length === 0 ? {} : { refHeader: references.join(' ') }),
          },
        },
      );

      // Sending above is the irreversible operation. A cleanup failure must
      // not turn it into a retryable failure and risk a duplicate delivery.
      await deleteRef(ref).catch(() => undefined);
      const providerMessageId = asString(sent.data?.messageId);
      const threadId = asString(sent.data?.threadId);
      return {
        ...(providerMessageId === undefined ? {} : { providerMessageId }),
        ...(threadId === undefined ? {} : { threadId, conversationId: threadId }),
      };
    },

    async deleteDraft(providerDraftId: string) {
      await deleteRef(await requireDraftRef(providerDraftId));
    },
  };
}
