export const MAILBOX_PROVIDERS = ['gmail', 'microsoft', 'zoho'] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export const MAILBOX_CONNECTION_STATUSES = [
  'connected',
  'disconnected',
  'expired',
  'revoked',
  'error',
  'disabled',
] as const;
export type MailboxConnectionStatus = (typeof MAILBOX_CONNECTION_STATUSES)[number];

export interface Mailbox {
  id: string;
  provider: MailboxProvider;
  emailAddress: string;
  displayName: string;
  enabled: boolean;
  connectionStatus: MailboxConnectionStatus;
  perRunDraftLimit: number;
  dailyDraftLimit: number;
  routingPriority: number;
  lastSuccessfulReadAt?: string;
  lastSuccessfulDraftAt?: string;
  lastTokenRefreshAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MailboxSummary {
  id: string;
  provider: MailboxProvider;
  emailAddress: string;
  connectionStatus: MailboxConnectionStatus;
  remainingDailyCapacity: number;
  lastSuccessfulReadAt?: string;
  requiresReconnection: boolean;
}

export interface NormalizedEmailAddress {
  name?: string;
  address: string;
}

export interface NormalizedEmail {
  mailboxId: string;
  provider: MailboxProvider;
  messageId: string;
  threadId?: string;
  conversationId?: string;
  internetMessageId?: string;
  from?: NormalizedEmailAddress;
  replyTo: NormalizedEmailAddress[];
  to: NormalizedEmailAddress[];
  cc: NormalizedEmailAddress[];
  subject: string;
  snippet?: string;
  textBody?: string;
  htmlBody?: string;
  receivedAt?: string;
  sentAt?: string;
  isRead: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  folderIds: string[];
  labelIds: string[];
  inReplyTo?: string;
  references: string[];
  providerWebUrl?: string;
}

export interface NormalizedThread {
  mailboxId: string;
  provider: MailboxProvider;
  threadId: string;
  subject: string;
  participants: NormalizedEmailAddress[];
  messages: NormalizedEmail[];
  lastActivityAt: string;
}
