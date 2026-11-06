import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { dailyMailboxUsage, mailboxes, oauthConnections, type Database } from '@yempik/database';
import {
  googleOAuthSettings,
  loadFeatureFlags,
  microsoftOAuthSettings,
  zohoOAuthSettings,
} from '@yempik/core';
import type { FeatureFlags, GatewayConfig, GatewayError } from '@yempik/core';
import { missingDeliveryScopes } from '@yempik/oauth';
import type { AuditWriter } from '@yempik/observability';
import type { McpAuthContext } from './auth.js';
import {
  MAX_SEARCH_LIMIT,
  createDatabaseMailboxStore,
  createMailSearchService,
  shapeEmailBody,
  toEmailSummary,
  toGatewayError,
  type AdapterFactory,
} from './mail-search.js';
import {
  MAX_ADOPTIONS_PER_CALL,
  MAX_DELETIONS_PER_CALL,
  MAX_DRAFTS_PER_CALL,
  createDatabaseDraftStore,
  createDraftService,
  type DraftAdapterFactory,
} from './draft-service.js';
import {
  MAX_REPLY_LIMIT,
  RELIABLE_MATCH_CONFIDENCE,
  createDatabaseReplyMatchingStore,
  createReplyMatchingService,
} from './reply-matching.js';
import { createDatabaseSignatureStore } from './signature-store.js';

/** Which providers have complete OAuth settings, hence a working adapter. */
export interface AdapterWiring {
  gmail: boolean;
  microsoft: boolean;
  zoho: boolean;
}

const NO_ADAPTERS: AdapterWiring = { gmail: false, microsoft: false, zoho: false };

export function adapterWiring(config: GatewayConfig | undefined): AdapterWiring {
  if (config === undefined) return NO_ADAPTERS;
  return {
    gmail: googleOAuthSettings(config) !== undefined,
    microsoft: microsoftOAuthSettings(config) !== undefined,
    zoho: zohoOAuthSettings(config) !== undefined,
  };
}

export interface HealthSnapshot {
  status: 'ok' | 'degraded';
  database: 'ok' | 'unavailable';
  configuration: 'ok';
  adapters: AdapterWiring;
}

// Readiness is the database alone: a deployment wired for a subset of the
// providers is healthy, and the adapters field says which subset.
export async function gatewayHealth(
  database: Database,
  adapters: AdapterWiring = NO_ADAPTERS,
): Promise<HealthSnapshot> {
  try {
    await database.execute(sql`select 1`);
    return { status: 'ok', database: 'ok', configuration: 'ok', adapters };
  } catch {
    return { status: 'degraded', database: 'unavailable', configuration: 'ok', adapters };
  }
}

async function mailboxSummaries(database: Database) {
  return database.execute<{
    id: string;
    provider: 'gmail' | 'microsoft' | 'zoho';
    email_address: string;
    aliases: string[];
    enabled: boolean;
    connection_status: 'connected' | 'disconnected' | 'expired' | 'revoked' | 'error' | 'disabled';
    granted_scopes: string[];
    daily_send_limit: number;
    daily_send_limits_by_identity: Record<string, number>;
    messages_sent_by_identity: Record<string, number>;
    remaining_daily_capacity: number;
    remaining_daily_send_capacity: number;
    last_successful_read_at: Date | string | null;
    requires_reconnection: boolean;
  }>(sql`
    SELECT
      m.id,
      m.provider,
      m.email_address,
      m.aliases,
      m.enabled,
      m.connection_status,
      -- The grant is frozen at consent time, so the stored scopes are the only
      -- evidence of what this mailbox may actually do. Scalar subquery: the
      -- table carries no uniqueness on (mailbox_id, provider).
      coalesce((
        SELECT c.scopes
        FROM ${oauthConnections} c
        WHERE c.mailbox_id = m.id AND c.provider = m.provider
        ORDER BY c.updated_at DESC
        LIMIT 1
      ), ARRAY[]::text[]) AS granted_scopes,
      m.daily_send_limit,
      m.daily_send_limits_by_identity,
      coalesce(u.messages_sent_by_identity, '{}'::jsonb) AS messages_sent_by_identity,
      greatest(m.daily_draft_limit - coalesce(u.drafts_created, 0), 0)::int AS remaining_daily_capacity,
      greatest(m.daily_send_limit - coalesce(u.messages_sent, 0), 0)::int AS remaining_daily_send_capacity,
      m.last_successful_read_at,
      (m.connection_status IN ('expired', 'revoked', 'error', 'disconnected')) AS requires_reconnection
    FROM ${mailboxes} m
    LEFT JOIN ${dailyMailboxUsage} u
      ON u.mailbox_id = m.id AND u.usage_date = current_date
    ORDER BY m.routing_priority, m.id
  `);
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function errorResult(error: GatewayError) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(error.toJSON()) }],
    isError: true,
  };
}

// Flags come from the process environment and never change while the process
// runs; loading them once keeps per-request server construction cheap.
let processFeatureFlags: FeatureFlags | undefined;
function activeFeatureFlags(): FeatureFlags {
  processFeatureFlags ??= loadFeatureFlags();
  return processFeatureFlags;
}

const searchEmailsInputSchema = {
  mailboxIds: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('Restrict the search to these mailbox ids; defaults to every connected mailbox.'),
  text: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  after: z.string().min(1).optional().describe('ISO 8601 inclusive lower bound.'),
  before: z.string().min(1).optional().describe('ISO 8601 exclusive upper bound.'),
  unreadOnly: z.boolean().optional(),
  hasAttachment: z.boolean().optional(),
  folder: z.enum(['inbox', 'sent', 'drafts', 'archive', 'all']).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  cursor: z.string().min(1).optional().describe('Opaque cursor returned by a previous search.'),
};

const getEmailInputSchema = {
  mailboxId: z.string().min(1).describe('Mailbox id from list_mailboxes.'),
  messageId: z.string().min(1).describe('Message id from search_emails or get_email_thread.'),
  includeBody: z.boolean().optional().describe('Fetch the body; defaults to true.'),
  bodyFormat: z
    .enum(['text', 'html', 'both'])
    .optional()
    .describe(
      'Body representation: "text" (default, falls back to HTML when no text part exists), "html", or "both".',
    ),
};

const getEmailThreadInputSchema = {
  mailboxId: z.string().min(1),
  threadId: z.string().min(1),
};

const listOutreachRepliesInputSchema = {
  campaignId: z
    .string()
    .min(1)
    .optional()
    .describe('Restrict to one campaign; omit for all known campaigns.'),
  mailboxIds: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'Restrict the scan to these mailbox ids; defaults to every connected mailbox that holds outreach references.',
    ),
  since: z
    .string()
    .min(1)
    .optional()
    .describe('ISO 8601 lower bound on the reply date; defaults to 14 days back.'),
  unreadOnly: z
    .boolean()
    .optional()
    .describe('Only consider messages still unread in the mailbox.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_REPLY_LIMIT)
    .describe(`Maximum replies to return, newest first. Default 20, maximum ${MAX_REPLY_LIMIT}.`)
    .optional(),
};

// Draft creation stays non-delivering. Autonomous delivery is always a second,
// explicit tool call against the returned gateway id.
const DRAFTS_ONLY_NOTE =
  'This operation only writes the message to the provider Drafts folder. To deliver it autonomously, call send_draft with the returned internalDraftId.';

// The gateway owns rendering: whatever form the body arrives in, providers get
// a text part plus an email-safe HTML part with the signature appended. The
// descriptions steer models towards Markdown because LLM-authored HTML tends to
// lose its blank-line paragraphs. textBody+htmlBody together stay accepted for
// clients built on the earlier contract; body is exclusive with both.
const MARKDOWN_BODY_DESCRIPTION =
  'Email body in Markdown. A blank line starts a new paragraph, a single line break is kept, use **bold**, *italic*, bullet lists and [link text](https://…). The gateway renders it to text and HTML, appends the stored signature of the sending identity and, on replies, quotes the original message below it. Prefer this over textBody/htmlBody. Provide body, or textBody and/or htmlBody (body cannot be combined with them), and do not write a signature or the quoted original yourself.';

const TEXT_BODY_DESCRIPTION =
  'Plain-text body; line breaks are preserved and a blank line starts a paragraph. Prefer `body`. Provide body, or textBody and/or htmlBody; next to htmlBody it is used as the plain-text part.';

const HTML_BODY_DESCRIPTION =
  'HTML email body. Use standard email-safe markup such as <a href="https://…">links</a>, <strong>bold</strong>, <em>italic</em>, <u>underline</u>, <p>, <br>, <ul>/<ol>/<li> and <blockquote>, with absolute HTTPS URLs. Bare line breaks are turned into paragraphs when the HTML has no block tags. Prefer `body`. Provide body, or textBody and/or htmlBody; without textBody the plain-text part is derived from the HTML.';

const INCLUDE_SIGNATURE_DESCRIPTION =
  'Append the signature stored for the sending identity (default true). Set false only when the message must end exactly where the body ends.';

const draftBodyFields = {
  body: z.string().min(1).optional().describe(MARKDOWN_BODY_DESCRIPTION),
  textBody: z.string().min(1).optional().describe(TEXT_BODY_DESCRIPTION),
  htmlBody: z.string().min(1).optional().describe(HTML_BODY_DESCRIPTION),
};

const includeSignatureField = z.boolean().optional().describe(INCLUDE_SIGNATURE_DESCRIPTION);

const outreachDraftEntrySchema = z.object({
  prospectId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Your CRM id for this prospect. Defaults to the normalized recipient address; it is what keeps the prospect bound to one mailbox across every step of the campaign.',
    ),
  to: z
    .string()
    .min(3)
    .describe(
      'Exactly one recipient email address. Batches are one draft per prospect; there is no cc/bcc and no multi-recipient draft.',
    ),
  subject: z.string().min(1).describe('Subject line of the draft.'),
  ...draftBodyFields,
});

const createOutreachDraftsInputSchema = {
  campaignId: z
    .string()
    .min(1)
    .describe(
      'Stable campaign identifier. Created on first use and reused for deduplication, prospect-to-mailbox stickiness and list_campaign_drafts.',
    ),
  routingMode: z
    .enum(['explicit', 'distributed'])
    .describe(
      '"explicit" puts every draft in the mailbox named by mailboxId. "distributed" lets the gateway spread them over the connected mailboxes by round-robin, while any prospect already assigned in this campaign keeps its original mailbox.',
    ),
  mailboxId: z
    .string()
    .min(1)
    .optional()
    .describe('Required when routingMode is "explicit". Use a mailboxId from list_mailboxes.'),
  fromAddress: z
    .string()
    .email()
    .optional()
    .describe(
      'Optional primary address or alias exposed by list_mailboxes. Requires routingMode "explicit"; the gateway rejects identities that do not belong to that mailbox.',
    ),
  sequenceStep: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Follow-up step number in the sequence, default 1. It is part of the deduplication key, so step 2 to the same prospect is a new draft while a repeated step 1 is a duplicate.',
    ),
  includeSignature: z
    .boolean()
    .optional()
    .describe(`${INCLUDE_SIGNATURE_DESCRIPTION} Applies to every draft of the batch.`),
  drafts: z
    .array(outreachDraftEntrySchema)
    .min(1)
    .max(MAX_DRAFTS_PER_CALL)
    .describe(
      `Up to ${MAX_DRAFTS_PER_CALL} drafts per call, one per prospect. Results come back in the same order.`,
    ),
};

const createReplyDraftInputSchema = {
  mailboxId: z
    .string()
    .min(1)
    .describe(
      'Mailbox that holds the message being answered (from list_mailboxes or the search result). The reply draft is always created in this same mailbox and thread; it cannot be redirected elsewhere.',
    ),
  sourceMessageId: z
    .string()
    .min(1)
    .describe('Message id of the message being answered, from search_emails or get_email_thread.'),
  replyMode: z
    .enum(['reply', 'replyAll'])
    .describe('"reply" answers the sender only, "replyAll" answers every recipient.'),
  fromAddress: z
    .string()
    .email()
    .optional()
    .describe('Optional primary address or alias of this mailbox to place in the From field.'),
  ...draftBodyFields,
  includeSignature: includeSignatureField,
  campaignId: z.string().min(1).optional().describe('Campaign this reply belongs to, if any.'),
  prospectId: z.string().min(1).optional().describe('Prospect this reply belongs to, if any.'),
};

const updateOutreachDraftInputSchema = {
  internalDraftId: z
    .string()
    .min(1)
    .describe(
      'The gateway draft id returned by create_outreach_drafts, create_reply_draft or list_campaign_drafts. Provider draft ids are not accepted: only drafts this gateway created can be modified.',
    ),
  subject: z.string().min(1).optional().describe('New subject line.'),
  to: z.string().min(3).optional().describe('New single recipient email address.'),
  fromAddress: z
    .string()
    .email()
    .optional()
    .describe('New primary address or alias of the draft mailbox to place in the From field.'),
  ...draftBodyFields,
  includeSignature: z
    .boolean()
    .optional()
    .describe(
      `${INCLUDE_SIGNATURE_DESCRIPTION} Only used when the body is replaced; the new body replaces the whole previous one, signature included.`,
    ),
};

const deleteOutreachDraftInputSchema = {
  internalDraftId: z
    .string()
    .min(1)
    .describe(
      'The gateway draft id to remove. Only drafts created by this gateway can be deleted; received and delivered messages are unreachable from here.',
    ),
};

const deleteOutreachDraftsInputSchema = {
  internalDraftIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_DELETIONS_PER_CALL)
    .describe(
      `Up to ${MAX_DELETIONS_PER_CALL} internal draft ids returned by draft creation, adoption or list_campaign_drafts.`,
    ),
};

const adoptExternalDraftsInputSchema = {
  mailboxId: z.string().min(1).describe('Mailbox that contains the existing drafts.'),
  providerMessageIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_ADOPTIONS_PER_CALL)
    .describe(
      `Up to ${MAX_ADOPTIONS_PER_CALL} messageId values returned by search_emails with folder "drafts". Gmail message ids are resolved to their stable draft ids automatically.`,
    ),
  campaignId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional campaign to associate with newly adopted drafts. It is organizational metadata, not required for later update or deletion.',
    ),
};

const listCampaignDraftsInputSchema = {
  campaignId: z.string().min(1).describe('Campaign whose drafts you want to list.'),
  status: z
    .enum([
      'creating',
      'created',
      'updated',
      'sending',
      'sent',
      'send_unknown',
      'deleted',
      'failed',
    ])
    .optional()
    .describe('Optional filter. Omit to list every draft recorded for the campaign.'),
};

const getDraftStatusInputSchema = {
  internalDraftId: z.string().min(1).describe('The gateway draft id to inspect.'),
};

const sendDraftInputSchema = {
  internalDraftId: z
    .string()
    .min(1)
    .describe(
      'Internal id returned by create_outreach_drafts, create_reply_draft, adopt_external_drafts or list_campaign_drafts. Provider ids and arbitrary message content are not accepted.',
    ),
};

const reconcileDraftSendInputSchema = {
  internalDraftId: z
    .string()
    .min(1)
    .describe('The gateway draft whose uncertain send outcome must be settled.'),
};

export interface McpServerOptions {
  /** Wired by the composition root; without it read tools report UNSUPPORTED_OPERATION. */
  adapterFactory?: AdapterFactory;
  /** Wired by the composition root; without it draft tools report UNSUPPORTED_OPERATION. */
  draftAdapterFactory?: DraftAdapterFactory;
  /** Overridable for tests; defaults to the process feature flags. */
  featureFlags?: FeatureFlags;
  /** GATEWAY_TIME_ZONE: IANA zone of the attribution line quoted below replies. */
  quoteTimeZone?: string;
  /** Reported by get_gateway_health; defaults to no provider wired. */
  adapters?: AdapterWiring;
}

export function createMcpServer(
  database: Database,
  audit: AuditWriter,
  auth: McpAuthContext,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: 'yempik-mail-gateway', version: '0.1.0' });
  const featureFlags = options.featureFlags ?? activeFeatureFlags();
  const mail = createMailSearchService({
    store: createDatabaseMailboxStore(database, auth.correlationId),
    adapterFactory: options.adapterFactory ?? (() => undefined),
    correlationId: auth.correlationId,
  });
  const drafts = createDraftService({
    store: createDatabaseDraftStore(database, auth.correlationId),
    draftAdapterFactory: options.draftAdapterFactory ?? (() => undefined),
    correlationId: auth.correlationId,
    signatureStore: createDatabaseSignatureStore(database),
    ...(options.quoteTimeZone === undefined ? {} : { quoteTimeZone: options.quoteTimeZone }),
  });
  const outreachReplies = createReplyMatchingService({
    store: createDatabaseReplyMatchingStore(database, auth.correlationId),
    adapterFactory: options.adapterFactory ?? (() => undefined),
    correlationId: auth.correlationId,
  });

  const recordAudit = async (event: {
    tool: string;
    operation: string;
    startedAt: number;
    result: 'succeeded' | 'failed';
    mailboxId?: string | undefined;
    resourceId?: string | undefined;
    errorCode?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void> => {
    await audit.write({
      mcpClientId: auth.mcpClientId,
      tool: event.tool,
      correlationId: auth.correlationId,
      operation: event.operation,
      result: event.result,
      providerLatencyMs: performance.now() - event.startedAt,
      ...(event.mailboxId === undefined ? {} : { mailboxId: event.mailboxId }),
      ...(event.resourceId === undefined ? {} : { resourceId: event.resourceId }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
    });
  };

  // audit_events.mailbox_id is a foreign key: an unknown mailbox must stay out
  // of the column and travel in the metadata instead.
  const auditableMailboxId = (mailboxId: string, errorCode?: string): string | undefined =>
    errorCode === 'MAILBOX_NOT_FOUND' ? undefined : mailboxId;

  server.registerTool(
    'get_gateway_health',
    {
      description:
        'Return technical gateway health (database, configuration, adapter wiring) without exposing secrets.',
    },
    async () => {
      const startedAt = performance.now();
      const health = await gatewayHealth(database, options.adapters);
      await audit.write({
        mcpClientId: auth.mcpClientId,
        tool: 'get_gateway_health',
        correlationId: auth.correlationId,
        operation: 'health_read',
        result: health.status,
        providerLatencyMs: performance.now() - startedAt,
      });
      return textResult(health);
    },
  );

  server.registerTool(
    'list_mailboxes',
    {
      description:
        'List the configured mailboxes with connection status, remaining daily draft/send capacity, per-sending-identity limits, delivery readiness (canSend, plus missingScopes naming any OAuth scope the stored grant lacks), and the mailboxId values every other tool accepts. Call this first when unsure which mailboxes exist, are connected, or can actually deliver: a mailbox can be connected and still have canSend false, because an OAuth grant keeps the scopes consented at connection time.',
    },
    async () => {
      const startedAt = performance.now();
      const result = await mailboxSummaries(database);
      const summaries = result.rows.map((row) => {
        const identities = [...new Set([row.email_address, ...row.aliases])].map((emailAddress) => {
          const normalized = emailAddress.trim().toLowerCase();
          const dailyLimit = row.daily_send_limits_by_identity[normalized] ?? row.daily_send_limit;
          const messagesSentToday = row.messages_sent_by_identity[normalized] ?? 0;
          return {
            emailAddress: normalized,
            dailyLimit,
            messagesSentToday,
            remainingDailyCapacity: Math.max(dailyLimit - messagesSentToday, 0),
          };
        });
        const missingScopes = missingDeliveryScopes(row.provider, row.granted_scopes);
        return {
          mailboxId: row.id,
          provider: row.provider,
          emailAddress: row.email_address,
          aliases: row.aliases,
          sendingIdentities: identities,
          status: row.connection_status,
          remainingDailyCapacity: row.remaining_daily_capacity,
          remainingDailySendCapacity: row.remaining_daily_send_capacity,
          // Raw execute() rows deliver timestamps as strings, not Date objects.
          ...(row.last_successful_read_at
            ? { lastSuccessfulReadAt: new Date(row.last_successful_read_at).toISOString() }
            : {}),
          requiresReconnection: row.requires_reconnection,
          // Connected is not the same as able to deliver: the grant is frozen
          // at consent time, so a mailbox consented before a delivery scope was
          // requested reads fine and cannot send.
          canSend:
            row.enabled && row.connection_status === 'connected' && missingScopes.length === 0,
          missingScopes,
        };
      });
      await audit.write({
        mcpClientId: auth.mcpClientId,
        tool: 'list_mailboxes',
        correlationId: auth.correlationId,
        operation: 'mailbox_registry_read',
        result: 'succeeded',
        providerLatencyMs: performance.now() - startedAt,
        metadata: { count: summaries.length },
      });
      return textResult({ mailboxes: summaries });
    },
  );

  if (featureFlags.SEARCH_EMAILS) {
    server.registerTool(
      'search_emails',
      {
        description:
          'Search messages across connected mailboxes. Returns summaries WITHOUT bodies (use get_email for content), partialFailures naming any mailbox that could not be searched with its error code (e.g. AUTH_REQUIRED = reconnect needed, UNSUPPORTED_OPERATION = provider adapter not available yet), and nextCursor to pass back as cursor for the next page. Omit mailboxIds to search every connected mailbox.',
        inputSchema: searchEmailsInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const result = await mail.searchAcrossMailboxes(input);
          await recordAudit({
            tool: 'search_emails',
            operation: 'email_search',
            startedAt,
            result: 'succeeded',
            metadata: {
              returned: result.emails.length,
              partialFailures: result.partialFailures.length,
              ...(input.mailboxIds === undefined ? {} : { requestedMailboxes: input.mailboxIds }),
            },
          });
          return textResult(result);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'search_emails',
            operation: 'email_search',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            metadata:
              input.mailboxIds === undefined ? undefined : { requestedMailboxes: input.mailboxIds },
          });
          return errorResult(failure);
        }
      },
    );

    server.registerTool(
      'list_outreach_replies',
      {
        description: [
          'Find inbox messages that look like replies to the outreach drafts this gateway created.',
          'It correlates incoming messages with the drafts recorded for your campaigns, so it only ever reports mailboxes that actually carry outreach; it does not read anything else.',
          'Every entry carries matchMethod and confidence.',
          `"thread", "inReplyTo", "references" and "messageId" (confidence ${RELIABLE_MATCH_CONFIDENCE} and above) rest on provider thread ids and Message-ID headers and can be trusted.`,
          '"recipientSubjectTime" (confidence 0.5) only means the sender address, the subject and the timing line up: it is a heuristic hint, NOT a certainty.',
          'Never present a match below 0.8 as a certain reply: open the conversation with get_email_thread (and get_email for the body) and confirm it before acting on it or answering it.',
          'partialFailures names any mailbox that could not be scanned with its error code (e.g. AUTH_REQUIRED = reconnect needed).',
        ].join(' '),
        inputSchema: listOutreachRepliesInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const result = await outreachReplies.listOutreachReplies(input);
          const lowConfidence = result.replies.filter(
            (reply) => reply.confidence < RELIABLE_MATCH_CONFIDENCE,
          ).length;
          await recordAudit({
            tool: 'list_outreach_replies',
            operation: 'outreach_reply_scan',
            startedAt,
            result: 'succeeded',
            ...(input.campaignId === undefined ? {} : { resourceId: input.campaignId }),
            metadata: {
              returned: result.replies.length,
              lowConfidence,
              partialFailures: result.partialFailures.length,
              ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
              ...(input.mailboxIds === undefined ? {} : { requestedMailboxes: input.mailboxIds }),
            },
          });
          return textResult(result);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'list_outreach_replies',
            operation: 'outreach_reply_scan',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            ...(input.campaignId === undefined ? {} : { resourceId: input.campaignId }),
            metadata: {
              returned: 0,
              ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
              ...(input.mailboxIds === undefined ? {} : { requestedMailboxes: input.mailboxIds }),
            },
          });
          return errorResult(failure);
        }
      },
    );
  }

  if (featureFlags.READ_EMAILS) {
    server.registerTool(
      'get_email',
      {
        description:
          'Read a single message from one mailbox. Returns the plain-text body by default; request bodyFormat "html" or "both" only when needed. Bodies over 50k characters are truncated with an explicit marker. Set includeBody false for headers and metadata only.',
        inputSchema: getEmailInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const email = shapeEmailBody(
            await mail.getEmailFromMailbox(input),
            input.bodyFormat ?? 'text',
          );
          await recordAudit({
            tool: 'get_email',
            operation: 'email_read',
            startedAt,
            result: 'succeeded',
            mailboxId: input.mailboxId,
            resourceId: input.messageId,
            metadata: {
              includeBody: input.includeBody ?? true,
              bodyFormat: input.bodyFormat ?? 'text',
            },
          });
          return textResult(email);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'get_email',
            operation: 'email_read',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.messageId,
            mailboxId: auditableMailboxId(input.mailboxId, failure.code),
            metadata: { mailboxId: input.mailboxId },
          });
          return errorResult(failure);
        }
      },
    );
  }

  if (featureFlags.READ_THREADS) {
    server.registerTool(
      'get_email_thread',
      {
        description:
          'Read a full conversation from one mailbox in chronological order. Messages are summaries WITHOUT bodies: fetch the content of a specific message with get_email. Threads are never merged across mailboxes.',
        inputSchema: getEmailThreadInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const thread = await mail.getThreadFromMailbox(input);
          const shaped = { ...thread, messages: thread.messages.map(toEmailSummary) };
          await recordAudit({
            tool: 'get_email_thread',
            operation: 'thread_read',
            startedAt,
            result: 'succeeded',
            mailboxId: input.mailboxId,
            resourceId: input.threadId,
            metadata: { messages: thread.messages.length },
          });
          return textResult(shaped);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'get_email_thread',
            operation: 'thread_read',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.threadId,
            mailboxId: auditableMailboxId(input.mailboxId, failure.code),
            metadata: { mailboxId: input.mailboxId },
          });
          return errorResult(failure);
        }
      },
    );
  }

  if (featureFlags.CREATE_DRAFTS) {
    server.registerTool(
      'create_outreach_drafts',
      {
        description: [
          `Create a batch of up to ${MAX_DRAFTS_PER_CALL} outreach drafts, one per prospect.`,
          DRAFTS_ONLY_NOTE,
          'Write each body in Markdown in `body`: the gateway renders it and appends the signature stored for the sending identity, so do not write a signature yourself.',
          'Routing: "explicit" targets one mailboxId from list_mailboxes; "distributed" spreads new prospects round-robin over the connected mailboxes, while any prospect already assigned in this campaign always stays on its original mailbox.',
          'Limits per mailbox: at most 5 new drafts per call (perRunDraftLimit) and 25 per day (dailyDraftLimit); the overflow entries come back as individual failures with PER_RUN_LIMIT_REACHED or DAILY_LIMIT_REACHED while the rest of the batch still succeeds.',
          'Deduplication key is campaignId + recipient + sequenceStep: repeating a call returns the existing draft with status "duplicate" and duplicatePrevented true, meaning no second draft was created in the mailbox.',
          'Results are returned in input order, each with its own status ("created", "duplicate" or "failed") and errorCode; where the code alone does not say what to do, errorMessage carries the explanation.',
          'Each call has a time budget: entries that would not finish within it come back as "failed" with the retryable errorCode BATCH_TIME_BUDGET_EXCEEDED before anything is created for them. Simply call again with those entries; repeating already created ones is harmless, they come back as "duplicate".',
        ].join(' '),
        inputSchema: createOutreachDraftsInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const result = await drafts.createOutreachDrafts(input);
          await recordAudit({
            tool: 'create_outreach_drafts',
            operation: 'draft_create_batch',
            startedAt,
            result: 'succeeded',
            resourceId: input.campaignId,
            metadata: {
              campaignId: input.campaignId,
              routingMode: input.routingMode,
              sequenceStep: result.sequenceStep,
              requested: result.summary.requested,
              created: result.summary.created,
              duplicates: result.summary.duplicates,
              failed: result.summary.failed,
              byMailbox: result.summary.byMailbox,
            },
          });
          return textResult(result);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'create_outreach_drafts',
            operation: 'draft_create_batch',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.campaignId,
            metadata: {
              campaignId: input.campaignId,
              routingMode: input.routingMode,
              requested: input.drafts.length,
            },
          });
          return errorResult(failure);
        }
      },
    );

    server.registerTool(
      'list_campaign_drafts',
      {
        description:
          'List the drafts this gateway recorded for a campaign, with their gateway draft id, mailbox, provider draft id, recipient, sequence step and current status. Use it to find the internalDraftId that update_outreach_draft and delete_outreach_draft need.',
        inputSchema: listCampaignDraftsInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const items = await drafts.listCampaignDrafts(input);
          await recordAudit({
            tool: 'list_campaign_drafts',
            operation: 'draft_list',
            startedAt,
            result: 'succeeded',
            resourceId: input.campaignId,
            metadata: {
              campaignId: input.campaignId,
              returned: items.length,
              ...(input.status === undefined ? {} : { status: input.status }),
            },
          });
          return textResult({ campaignId: input.campaignId, drafts: items });
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'list_campaign_drafts',
            operation: 'draft_list',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.campaignId,
            metadata: { campaignId: input.campaignId },
          });
          return errorResult(failure);
        }
      },
    );

    server.registerTool(
      'get_draft_status',
      {
        description:
          'Check one gateway draft: the stored row plus a live check against the provider. stillExists false means the draft is no longer in the mailbox (someone delivered or removed it by hand); providerCheckErrorCode is set when the live check itself could not be completed. reconciliationHint is present when the send outcome is unknown and only reconcile_draft_send can settle it.',
        inputSchema: getDraftStatusInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const status = await drafts.getDraftStatus(input);
          await recordAudit({
            tool: 'get_draft_status',
            operation: 'draft_status',
            startedAt,
            result: 'succeeded',
            resourceId: input.internalDraftId,
            mailboxId: status.mailboxId,
            metadata: {
              status: status.status,
              stillExists: status.stillExists,
              awaitingReconciliation: status.reconciliationHint !== undefined,
              ...(status.providerCheckErrorCode === undefined
                ? {}
                : { providerCheckErrorCode: status.providerCheckErrorCode }),
            },
          });
          return textResult(status);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'get_draft_status',
            operation: 'draft_status',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.internalDraftId,
          });
          return errorResult(failure);
        }
      },
    );
  }

  if (featureFlags.CREATE_REPLY_DRAFTS) {
    server.registerTool(
      'create_reply_draft',
      {
        description: [
          'Create a reply draft inside the original thread of a message.',
          DRAFTS_ONLY_NOTE,
          'Write only your answer, in Markdown in `body`: the gateway appends the signature stored for the sending identity and quotes the original message below it, so include neither yourself.',
          'The draft is always created in the same mailbox that holds the source message: a reply cannot be moved to another mailbox.',
          'Calling it twice with the same mailbox, message, reply mode and body returns the existing draft with status "duplicate" and duplicatePrevented true instead of creating a second one.',
        ].join(' '),
        inputSchema: createReplyDraftInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const result = await drafts.createReplyDraft(input);
          await recordAudit({
            tool: 'create_reply_draft',
            operation: 'draft_reply_create',
            startedAt,
            result: 'succeeded',
            mailboxId: input.mailboxId,
            resourceId: result.internalDraftId ?? input.sourceMessageId,
            metadata: {
              replyMode: input.replyMode,
              sourceMessageId: input.sourceMessageId,
              status: result.status,
              duplicatePrevented: result.duplicatePrevented,
              created: result.status === 'created' ? 1 : 0,
              duplicates: result.status === 'duplicate' ? 1 : 0,
              ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
            },
          });
          return textResult(result);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'create_reply_draft',
            operation: 'draft_reply_create',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.sourceMessageId,
            mailboxId: auditableMailboxId(input.mailboxId, failure.code),
            metadata: { mailboxId: input.mailboxId, replyMode: input.replyMode },
          });
          return errorResult(failure);
        }
      },
    );
  }

  if (featureFlags.SEND_EMAILS) {
    server.registerTool(
      'send_draft',
      {
        description: [
          'Autonomously deliver one existing gateway-managed draft without waiting for human approval.',
          'Only internalDraftId is accepted: arbitrary emails and provider message ids cannot be sent directly.',
          'The operation is idempotent. A draft already marked sent is returned without contacting the provider again.',
          'On an ambiguous provider timeout the gateway blocks automatic retries with SEND_STATUS_UNKNOWN to prevent duplicate delivery.',
          'A successful result means the provider accepted the message; it does not guarantee recipient delivery.',
        ].join(' '),
        inputSchema: sendDraftInputSchema,
        annotations: {
          title: 'Send gateway draft',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const result = await drafts.sendDraft(input);
          await recordAudit({
            tool: 'send_draft',
            operation: 'draft_send',
            startedAt,
            result: 'succeeded',
            mailboxId: result.mailboxId,
            resourceId: result.internalDraftId,
            metadata: {
              status: result.status,
              alreadySent: result.alreadySent,
              ...(result.campaignId === undefined ? {} : { campaignId: result.campaignId }),
            },
          });
          return textResult(result);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'send_draft',
            operation: 'draft_send',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.internalDraftId,
          });
          return errorResult(failure);
        }
      },
    );

    server.registerTool(
      'reconcile_draft_send',
      {
        description: [
          'Settle a draft whose send outcome is unknown. This is the only way out of SEND_STATUS_UNKNOWN: no other tool can move a draft out of status "send_unknown", and a stale "sending" claim left by a crashed process is admissible too.',
          'The gateway asks the mailbox itself: whether the provider draft is still in Drafts, and whether the Sent folder holds a copy to the same recipient with the same subject dated at or after the claim.',
          'Outcome "sent" records the delivery with the provider message id found in Sent. Outcome "not_sent" proves nothing was delivered: the draft returns to status "created", its send quota is given back and send_draft accepts it again. Outcome "unresolved" means the evidence was incomplete; the row is left untouched, reason says what was missing, and calling it again later is safe.',
          'Never conclude a send yourself and never retry send_draft on an uncertain draft: run this instead.',
        ].join(' '),
        inputSchema: reconcileDraftSendInputSchema,
        annotations: {
          title: 'Reconcile uncertain send',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const result = await drafts.reconcileDraftSend(input);
          await recordAudit({
            tool: 'reconcile_draft_send',
            operation: 'draft_send_reconcile',
            startedAt,
            result: 'succeeded',
            mailboxId: result.mailboxId,
            resourceId: result.internalDraftId,
            metadata: {
              outcome: result.outcome,
              status: result.status,
              evidence: result.evidence,
              ...(result.reason === undefined ? {} : { reason: result.reason }),
              ...(result.campaignId === undefined ? {} : { campaignId: result.campaignId }),
            },
          });
          return textResult(result);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'reconcile_draft_send',
            operation: 'draft_send_reconcile',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.internalDraftId,
          });
          return errorResult(failure);
        }
      },
    );
  }

  if (featureFlags.UPDATE_DRAFTS || featureFlags.DELETE_GATEWAY_DRAFTS) {
    server.registerTool(
      'adopt_external_drafts',
      {
        description: [
          `Bring up to ${MAX_ADOPTIONS_PER_CALL} existing provider drafts under gateway management in one call, including legacy or human-created drafts.`,
          'First find them with search_emails using folder "drafts", then pass those result messageId values here; do not guess provider draft ids.',
          'Every item is verified live as an unsent draft by Gmail, Outlook or Zoho before the gateway records it. Received and delivered messages are rejected and remain unreachable.',
          'The result is partial-success and stays in input order. Use each returned draft.internalDraftId with update_outreach_draft or delete_outreach_draft; campaignId is optional.',
          'Each call has a time budget: items it cannot cover come back as "failed" with the retryable errorCode BATCH_TIME_BUDGET_EXCEEDED before the provider is read. Call again with those items; adopting an already managed draft again is harmless.',
          DRAFTS_ONLY_NOTE,
        ].join(' '),
        inputSchema: adoptExternalDraftsInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const result = await drafts.adoptExternalDrafts(input);
          await recordAudit({
            tool: 'adopt_external_drafts',
            operation: 'draft_adopt_batch',
            startedAt,
            result: 'succeeded',
            mailboxId: input.mailboxId,
            ...(input.campaignId === undefined ? {} : { resourceId: input.campaignId }),
            metadata: {
              requested: result.summary.requested,
              adopted: result.summary.adopted,
              alreadyManaged: result.summary.alreadyManaged,
              failed: result.summary.failed,
              ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
            },
          });
          return textResult(result);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'adopt_external_drafts',
            operation: 'draft_adopt_batch',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            mailboxId: auditableMailboxId(input.mailboxId, failure.code),
            metadata: { mailboxId: input.mailboxId, requested: input.providerMessageIds.length },
          });
          return errorResult(failure);
        }
      },
    );
  }

  if (featureFlags.UPDATE_DRAFTS) {
    server.registerTool(
      'update_outreach_draft',
      {
        description: [
          'Rewrite the subject, recipient or body of a draft this gateway created and that still exists in the mailbox.',
          DRAFTS_ONLY_NOTE,
          'A new body (Markdown in `body`) replaces the whole previous one: the gateway appends the signature again and, on a reply draft, keeps the quoted conversation below it. `quoteRebuilt: true` in the result means the provider quote could not be kept and only the original message was quoted again.',
          'Only an internalDraftId from create_outreach_drafts, create_reply_draft, adopt_external_drafts or list_campaign_drafts is accepted. External drafts must be adopted and verified first; a draft that was deleted or never completed answers DRAFT_NOT_FOUND.',
        ].join(' '),
        inputSchema: updateOutreachDraftInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const summary = await drafts.updateOutreachDraft(input);
          await recordAudit({
            tool: 'update_outreach_draft',
            operation: 'draft_update',
            startedAt,
            result: 'succeeded',
            mailboxId: summary.mailboxId,
            resourceId: summary.internalDraftId,
            metadata: {
              updated: 1,
              fields: Object.keys(input).filter((key) => key !== 'internalDraftId'),
              ...(summary.campaignId === undefined ? {} : { campaignId: summary.campaignId }),
            },
          });
          return textResult(summary);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'update_outreach_draft',
            operation: 'draft_update',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.internalDraftId,
          });
          return errorResult(failure);
        }
      },
    );
  }

  if (featureFlags.DELETE_GATEWAY_DRAFTS) {
    server.registerTool(
      'delete_outreach_drafts',
      {
        description: [
          `Remove up to ${MAX_DELETIONS_PER_CALL} managed drafts from their provider Drafts folders in one call.`,
          'The operation is partial-success and returns one result in input order, so one stale or invalid id does not block the rest.',
          'Each call has a time budget: ids it cannot cover come back as "failed" with the retryable errorCode BATCH_TIME_BUDGET_EXCEEDED before the provider is called. Call again with those ids.',
          'Use adopt_external_drafts first for legacy or human-created drafts. Every target has already been provider-verified as an unsent draft; received and delivered messages are unreachable.',
          DRAFTS_ONLY_NOTE,
        ].join(' '),
        inputSchema: deleteOutreachDraftsInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const result = await drafts.deleteOutreachDrafts(input);
          await recordAudit({
            tool: 'delete_outreach_drafts',
            operation: 'draft_delete_batch',
            startedAt,
            result: 'succeeded',
            metadata: result.summary,
          });
          return textResult(result);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'delete_outreach_drafts',
            operation: 'draft_delete_batch',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            metadata: { requested: input.internalDraftIds.length },
          });
          return errorResult(failure);
        }
      },
    );

    server.registerTool(
      'delete_outreach_draft',
      {
        description:
          'Remove a managed draft from the mailbox Drafts folder. It only accepts an internalDraftId issued by this gateway; legacy or human-created drafts must first pass adopt_external_drafts, which verifies they are still unsent drafts. Received and delivered messages remain out of reach. An unknown or already deleted id answers DRAFT_NOT_FOUND.',
        inputSchema: deleteOutreachDraftInputSchema,
      },
      async (input) => {
        const startedAt = performance.now();
        try {
          const summary = await drafts.deleteOutreachDraft(input);
          await recordAudit({
            tool: 'delete_outreach_draft',
            operation: 'draft_delete',
            startedAt,
            result: 'succeeded',
            mailboxId: summary.mailboxId,
            resourceId: summary.internalDraftId,
            metadata: {
              deleted: 1,
              ...(summary.campaignId === undefined ? {} : { campaignId: summary.campaignId }),
            },
          });
          return textResult(summary);
        } catch (error) {
          const failure = toGatewayError(error, auth.correlationId);
          await recordAudit({
            tool: 'delete_outreach_draft',
            operation: 'draft_delete',
            startedAt,
            result: 'failed',
            errorCode: failure.code,
            resourceId: input.internalDraftId,
          });
          return errorResult(failure);
        }
      },
    );
  }

  return server;
}
