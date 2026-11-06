// Search, draft and delivery contracts. The normalized email/thread model
// lives in types.ts. Delivery is deliberately restricted to drafts already
// owned by the gateway; adapters never expose arbitrary message sending.

import type { MailboxProvider, NormalizedEmail, NormalizedThread } from './types.js';

export type SearchFolder = 'inbox' | 'sent' | 'drafts' | 'archive' | 'all';

/** Provider-neutral search filters; adapters translate to Gmail `q` / Graph `$filter`. */
export interface NormalizedSearchQuery {
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** ISO 8601 date or datetime (inclusive lower bound). */
  after?: string;
  /** ISO 8601 date or datetime (exclusive upper bound). */
  before?: string;
  unreadOnly?: boolean;
  hasAttachment?: boolean;
  folder?: SearchFolder;
  limit?: number;
  cursor?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * A send-as identity as the provider reports it. Only Gmail exposes the
 * signature through its API; Microsoft Graph and Zoho have no equivalent, so
 * their adapters do not implement `listSendingIdentities`.
 */
export interface ProviderSendingIdentity {
  emailAddress: string;
  displayName?: string;
  /** Provider-side HTML signature; absent when the identity has none. */
  signatureHtml?: string;
  isPrimary: boolean;
}

export interface ConnectionHealth {
  status: 'ok' | 'error';
  emailAddress?: string;
  detail?: string;
}

/**
 * Read-side provider contract. One adapter instance is bound to one
 * mailbox. Body content is fetched on demand (`includeBody`) and never
 * persisted. Draft and delivery operations live in a separate interface.
 */
export interface MailProviderAdapter {
  readonly mailboxId: string;
  readonly provider: MailboxProvider;
  verifyConnection(): Promise<ConnectionHealth>;
  searchEmails(query: NormalizedSearchQuery): Promise<PaginatedResult<NormalizedEmail>>;
  getEmail(messageId: string, options?: { includeBody?: boolean }): Promise<NormalizedEmail>;
  getThread(threadId: string): Promise<NormalizedThread>;
  /** Send-as identities with their provider-side signature, when the provider exposes them (Gmail). */
  listSendingIdentities?(): Promise<ProviderSendingIdentity[]>;
}

/** Resolves a live provider access token for a mailbox (refresh handled inside). */
export interface AccessTokenProvider {
  getAccessToken(mailboxId: string, correlationId: string): Promise<{ accessToken: string }>;
}

// ---- Draft and delivery contract ----
// Sending accepts a provider draft id only. Creating and sending an arbitrary
// message in one provider call is intentionally not part of this contract.

export interface ProviderDraftInput {
  to: string[];
  cc?: string[];
  /** Optional verified sending identity of the mailbox (primary address or alias). */
  from?: string;
  /** Display name to pair with `from`; adapters format it per provider. */
  fromDisplayName?: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  replyTo?: string;
}

export interface ProviderReplyDraftInput {
  sourceMessageId: string;
  replyMode: 'reply' | 'replyAll';
  /** Optional verified sending identity of the mailbox (primary address or alias). */
  from?: string;
  /** Display name to pair with `from`; adapters format it per provider. */
  fromDisplayName?: string;
  textBody?: string;
  htmlBody?: string;
  /** Append the quoted original below the body (default true); the body already carries the signature. */
  quoteOriginal?: boolean;
  /** IANA time zone for the quote attribution line (default UTC). */
  quoteTimeZone?: string;
}

export interface ProviderDraftUpdate {
  to?: string[];
  /** Optional verified sending identity of the mailbox (primary address or alias). */
  from?: string;
  /** Display name to pair with `from`; adapters format it per provider. */
  fromDisplayName?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  /**
   * When a reply draft's body is replaced, the provider message to quote again
   * below the new body, so the update does not drop the conversation history.
   */
  quoteOriginalMessageId?: string;
  /** IANA time zone for the quote attribution line (default UTC). */
  quoteTimeZone?: string;
}

export interface ProviderDraftSnapshot {
  providerDraftId: string;
  providerMessageId?: string;
  /** Resolved mailbox primary/alias identity when the provider exposes it. */
  from?: string;
  threadId?: string;
  conversationId?: string;
  internetMessageId?: string;
  providerWebUrl?: string;
  subject?: string;
  to?: string[];
  /**
   * True when the provider's original quote could not be preserved and the
   * gateway rebuilt it from the source message.
   */
  quoteRebuilt?: boolean;
}

export interface ProviderSendReceipt {
  /** Provider id of the accepted/sent message when the API returns one. */
  providerMessageId?: string;
  threadId?: string;
  conversationId?: string;
  internetMessageId?: string;
}

export interface MailDraftAdapter {
  readonly mailboxId: string;
  readonly provider: MailboxProvider;
  createDraft(input: ProviderDraftInput): Promise<ProviderDraftSnapshot>;
  createReplyDraft(input: ProviderReplyDraftInput): Promise<ProviderDraftSnapshot>;
  updateDraft(providerDraftId: string, update: ProviderDraftUpdate): Promise<ProviderDraftSnapshot>;
  getDraft(providerDraftId: string): Promise<ProviderDraftSnapshot>;
  /** Resolves the stable provider draft behind a message id returned by draft-folder search. */
  getDraftByMessageId(providerMessageId: string): Promise<ProviderDraftSnapshot>;
  /** Sends exactly this existing draft; it must not accept arbitrary content. */
  sendDraft(providerDraftId: string): Promise<ProviderSendReceipt>;
  /** MUST verify the target is a draft and refuse anything else. */
  deleteDraft(providerDraftId: string): Promise<void>;
}
