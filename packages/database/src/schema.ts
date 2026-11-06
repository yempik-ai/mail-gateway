import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const mailboxProvider = pgEnum('mailbox_provider', ['gmail', 'microsoft', 'zoho']);
export const mailboxConnectionStatus = pgEnum('mailbox_connection_status', [
  'connected',
  'disconnected',
  'expired',
  'revoked',
  'error',
  'disabled',
]);
export const draftStatus = pgEnum('draft_status', [
  'creating',
  'created',
  'updated',
  'sending',
  'sent',
  'send_unknown',
  'deleted',
  'failed',
]);
export const operationStatus = pgEnum('operation_status', ['started', 'succeeded', 'failed']);

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mailboxes = pgTable('mailboxes', {
  id: text('id').primaryKey(),
  provider: mailboxProvider('provider').notNull(),
  emailAddress: text('email_address').notNull(),
  aliases: text('aliases')
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  microsoftTenantId: text('microsoft_tenant_id'),
  displayName: text('display_name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  connectionStatus: mailboxConnectionStatus('connection_status').notNull().default('disconnected'),
  perRunDraftLimit: integer('per_run_draft_limit').notNull().default(5),
  dailyDraftLimit: integer('daily_draft_limit').notNull().default(25),
  dailySendLimit: integer('daily_send_limit').notNull().default(25),
  dailySendLimitsByIdentity: jsonb('daily_send_limits_by_identity')
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  routingPriority: integer('routing_priority').notNull(),
  lastSuccessfulReadAt: timestamp('last_successful_read_at', { withTimezone: true }),
  lastSuccessfulDraftAt: timestamp('last_successful_draft_at', { withTimezone: true }),
  lastSuccessfulSendAt: timestamp('last_successful_send_at', { withTimezone: true }),
  lastTokenRefreshAt: timestamp('last_token_refresh_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  ...timestamps(),
});

/**
 * Signature of one sending identity (primary address or alias) of a mailbox.
 * `identity_email` is stored trimmed and lowercased; `signature_text` stays
 * NULL when only HTML was provided, because the renderer derives it.
 */
export const mailboxSignatures = pgTable(
  'mailbox_signatures',
  {
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    identityEmail: text('identity_email').notNull(),
    displayName: text('display_name'),
    signatureHtml: text('signature_html'),
    signatureText: text('signature_text'),
    source: text('source').$type<'manual' | 'gmail'>().notNull().default('manual'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [primaryKey({ columns: [table.mailboxId, table.identityEmail] })],
);

export const oauthConnections = pgTable('oauth_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  mailboxId: text('mailbox_id')
    .notNull()
    .references(() => mailboxes.id, { onDelete: 'cascade' }),
  provider: mailboxProvider('provider').notNull(),
  providerAccountId: text('provider_account_id'),
  scopes: text('scopes')
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  status: mailboxConnectionStatus('status').notNull().default('disconnected'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps(),
});

export const oauthTokenVersions = pgTable('oauth_token_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  oauthConnectionId: uuid('oauth_connection_id')
    .notNull()
    .references(() => oauthConnections.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce').notNull(),
  authTag: text('auth_tag').notNull(),
  keyVersion: integer('key_version').notNull(),
  tokenKind: text('token_kind').notNull(),
  active: boolean('active').notNull().default(true),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
});

export const campaigns = pgTable('campaigns', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
  ...timestamps(),
});

export const prospectMailboxAssignments = pgTable(
  'prospect_mailbox_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    prospectId: text('prospect_id').notNull(),
    normalizedRecipientEmail: text('normalized_recipient_email').notNull(),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('prospect_mailbox_assignments_campaign_recipient_unique').on(
      table.campaignId,
      table.normalizedRecipientEmail,
    ),
  ],
);

export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: text('idempotency_key').notNull().unique('drafts_idempotency_key_unique'),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id),
    provider: mailboxProvider('provider').notNull(),
    providerDraftId: text('provider_draft_id'),
    providerMessageId: text('provider_message_id'),
    providerWebUrl: text('provider_web_url'),
    sendingIdentityEmail: text('sending_identity_email').notNull(),
    campaignId: text('campaign_id').references(() => campaigns.id),
    prospectId: text('prospect_id'),
    normalizedRecipientEmail: text('normalized_recipient_email'),
    sequenceStep: integer('sequence_step'),
    sourceMessageId: text('source_message_id'),
    contentHash: text('content_hash'),
    status: draftStatus('status').notNull().default('creating'),
    providerSentMessageId: text('provider_sent_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('drafts_campaign_recipient_sequence_unique').on(
      table.campaignId,
      table.normalizedRecipientEmail,
      table.sequenceStep,
    ),
  ],
);

export const draftOperations = pgTable('draft_operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  draftId: uuid('draft_id')
    .notNull()
    .references(() => drafts.id, { onDelete: 'cascade' }),
  operation: text('operation').notNull(),
  status: operationStatus('status').notNull(),
  retryCount: integer('retry_count').notNull().default(0),
  errorCode: text('error_code'),
  correlationId: uuid('correlation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messageReferences = pgTable(
  'message_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id').references(() => drafts.id, { onDelete: 'set null' }),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id),
    campaignId: text('campaign_id').references(() => campaigns.id),
    prospectId: text('prospect_id'),
    providerMessageId: text('provider_message_id').notNull(),
    threadId: text('thread_id'),
    conversationId: text('conversation_id'),
    internetMessageId: text('internet_message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('references')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    normalizedSender: text('normalized_sender'),
    normalizedRecipient: text('normalized_recipient'),
    subject: text('subject'),
    snippet: text('snippet'),
    contentHash: text('content_hash'),
    messageAt: timestamp('message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('message_references_draft_id_idx').on(table.draftId)],
);

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  operation: text('operation').notNull(),
  status: operationStatus('status').notNull().default('started'),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  response: jsonb('response').$type<Record<string, unknown>>(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dailyMailboxUsage = pgTable(
  'daily_mailbox_usage',
  {
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    usageDate: date('usage_date').notNull(),
    draftsCreated: integer('drafts_created').notNull().default(0),
    messagesSent: integer('messages_sent').notNull().default(0),
    messagesSentByIdentity: jsonb('messages_sent_by_identity')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.mailboxId, table.usageDate] })],
);

export const mcpClients = pgTable('mcp_clients', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  secretHash: text('secret_hash').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  allowlisted: boolean('allowlisted').notNull().default(true),
  globalKillSwitch: boolean('global_kill_switch').notNull().default(false),
  environment: text('environment').notNull(),
  lastAuthenticatedAt: timestamp('last_authenticated_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps(),
});

export const mcpOauthGrants = pgTable('mcp_oauth_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  mcpClientId: text('mcp_client_id')
    .notNull()
    .references(() => mcpClients.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  codeChallenge: text('code_challenge'),
  redirectUri: text('redirect_uri'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  mcpClientId: text('mcp_client_id').references(() => mcpClients.id, { onDelete: 'set null' }),
  tool: text('tool'),
  correlationId: uuid('correlation_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  mailboxId: text('mailbox_id').references(() => mailboxes.id, { onDelete: 'set null' }),
  campaignId: text('campaign_id'),
  prospectId: text('prospect_id'),
  resourceId: text('resource_id'),
  operation: text('operation').notNull(),
  result: text('result').notNull(),
  errorCode: text('error_code'),
  retryCount: integer('retry_count').notNull().default(0),
  idempotencyKey: text('idempotency_key'),
  providerLatencyMs: numeric('provider_latency_ms', { precision: 12, scale: 3 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
});
