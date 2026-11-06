// Mailbox management from the admin dashboard, so a deployment can register
// and tune its mailboxes without shell access or a registry file. Every input
// goes through the same zod schema as the seed file, and the audit trail
// records identifiers and changed field names only, never addresses.

import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import {
  changedAccountFields,
  escapeHtml,
  formatRegistryIssues,
  lockedAccountChanges,
  MAILBOX_ACCOUNT_LOCK_EXPLANATION,
  MAILBOX_PROVIDERS,
  mailboxAddressConflict,
  mailboxIdentities,
  mailboxRegistryEntrySchema,
  resolveMailboxRecord,
  WARM_UP_DAILY_SEND_LIMIT,
  type MailboxAddresses,
  type MailboxProvider,
  type MailboxRecord,
  type MailboxRegistryEntryInput,
} from '@yempik/core';
import { mailboxes, mailboxHasOAuthConnection, type Database } from '@yempik/database';
import type { AuditWriter } from '@yempik/observability';

/** The stored columns the editor shows and the routes validate against. */
export interface MailboxSettingsRow extends Record<string, unknown> {
  id: string;
  provider: MailboxProvider;
  email_address: string;
  aliases: string[];
  display_name: string;
  microsoft_tenant_id: string | null;
  routing_priority: number;
  per_run_draft_limit: number;
  daily_draft_limit: number;
  daily_send_limit: number;
  daily_send_limits_by_identity: Record<string, number>;
  enabled: boolean;
  /**
   * Any stored OAuth connection, whatever its status: its token belongs to the
   * account it was minted for, so provider, address and tenant are frozen.
   */
  has_oauth_connection: boolean;
}

export interface MailboxAdminDependencies {
  database: Database;
  audit: AuditWriter;
  /** The dashboard's own guards (admin authentication and anything added later). */
  preHandler: preHandlerHookHandler | preHandlerHookHandler[];
  rateLimit: { rateLimit: { max: number; timeWindow: number } };
}

const PROVIDER_LABELS: Record<MailboxProvider, string> = {
  gmail: 'Gmail (Google Workspace)',
  microsoft: 'Microsoft 365 / Outlook',
  zoho: 'Zoho Mail',
};

const SEND_LIMIT_FIELD_PREFIX = 'sendLimit:';

// The seed refuses the same changes with the same words.
const LOCKED_EXPLANATION = MAILBOX_ACCOUNT_LOCK_EXPLANATION;

function providerOptions(selected: MailboxProvider | undefined): string {
  return MAILBOX_PROVIDERS.map(
    (provider) =>
      `<option value="${provider}"${provider === selected ? ' selected' : ''}>${escapeHtml(PROVIDER_LABELS[provider])}</option>`,
  ).join('');
}

function numberInput(label: string, name: string, value: number): string {
  return `<label>${escapeHtml(label)} <input type="number" min="0" step="1" name="${escapeHtml(name)}" value="${value}"></label>`;
}

/** The form under "Edit" on each mailbox row. */
export function renderMailboxEditor(mailbox: MailboxSettingsRow): string {
  const identities = mailboxIdentities(mailbox.email_address, mailbox.aliases);
  const lockedFields = mailbox.has_oauth_connection
    ? [
        `<p class="note">${escapeHtml(LOCKED_EXPLANATION)}</p>`,
        `<p>Provider: <strong>${escapeHtml(PROVIDER_LABELS[mailbox.provider])}</strong><br>`,
        `Primary address: <strong>${escapeHtml(mailbox.email_address)}</strong>`,
        mailbox.provider === 'microsoft'
          ? `<br>Microsoft tenant: <strong>${escapeHtml(mailbox.microsoft_tenant_id ?? 'default')}</strong>`
          : '',
        '</p>',
      ].join('')
    : [
        `<label>Provider <select name="provider">${providerOptions(mailbox.provider)}</select></label>`,
        `<label>Primary address <input type="email" name="emailAddress" required value="${escapeHtml(mailbox.email_address)}"></label>`,
        '<label>Microsoft tenant ID (Microsoft only, optional) ',
        `<input type="text" name="microsoftTenantId" value="${escapeHtml(mailbox.microsoft_tenant_id ?? '')}"></label>`,
      ].join('');
  const sendLimitInputs = identities
    .map((identity) =>
      numberInput(
        identity,
        `${SEND_LIMIT_FIELD_PREFIX}${identity}`,
        mailbox.daily_send_limits_by_identity[identity] ?? mailbox.daily_send_limit,
      ),
    )
    .join('');
  return [
    '<details><summary>Edit</summary>',
    `<form class="mailbox-form" method="post" action="/admin/mailboxes/${escapeHtml(encodeURIComponent(mailbox.id))}/update">`,
    lockedFields,
    `<label>Display name <input type="text" name="displayName" value="${escapeHtml(mailbox.display_name)}"></label>`,
    `<label>Aliases (comma-separated) <input type="text" name="aliases" value="${escapeHtml(mailbox.aliases.join(', '))}"></label>`,
    numberInput('Drafts per run', 'perRunDraftLimit', mailbox.per_run_draft_limit),
    numberInput('Drafts per day', 'dailyDraftLimit', mailbox.daily_draft_limit),
    '<fieldset><legend>Sends per day, per identity</legend>',
    sendLimitInputs,
    `<p class="note">A new alias starts at ${WARM_UP_DAILY_SEND_LIMIT} sends per day. `,
    'Save it first, then raise its limit here.</p></fieldset>',
    '<button type="submit">Save changes</button></form></details>',
  ].join('');
}

/** The "Add a mailbox" form below the mailbox table. */
export function renderAddMailboxForm(): string {
  return [
    '<h3>Add a mailbox</h3>',
    '<p>A new mailbox starts disconnected, with ',
    `${WARM_UP_DAILY_SEND_LIMIT} sends per day for each address. `,
    'After you add it, click <strong>Connect</strong> on its row to sign in to the account.</p>',
    '<form class="mailbox-form" method="post" action="/admin/mailboxes">',
    '<label>ID (lowercase letters, digits and hyphens) ',
    '<input type="text" name="id" required maxlength="64" placeholder="sales-outlook"></label>',
    `<label>Provider <select name="provider">${providerOptions(undefined)}</select></label>`,
    '<label>Primary address <input type="email" name="emailAddress" required></label>',
    '<label>Aliases (comma-separated, optional) <input type="text" name="aliases"></label>',
    '<label>Microsoft tenant ID (Microsoft only, optional) <input type="text" name="microsoftTenantId"></label>',
    '<label>Display name (optional) <input type="text" name="displayName"></label>',
    '<button type="submit">Add mailbox</button></form>',
  ].join('');
}

/** A form-encoded field; repeated fields (an array) are rejected as absent. */
function formField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

/** Empty means "not provided", so a blank optional input never fails validation. */
function optionalText(body: Record<string, unknown>, name: string): string | undefined {
  const value = formField(body, name)?.trim();
  return value ? value : undefined;
}

function parseAliases(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,;]+/)
    .map((alias) => alias.trim())
    .filter(Boolean);
}

/**
 * Whole numbers only. Anything else is passed through as-is so the schema
 * reports it with the field name instead of a silent NaN or truncation.
 */
function parseLimit(value: string | undefined): number | string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function parseSendLimits(body: Record<string, unknown>): Record<string, number | string> {
  const limits: Record<string, number | string> = {};
  for (const name of Object.keys(body)) {
    if (!name.startsWith(SEND_LIMIT_FIELD_PREFIX)) continue;
    const limit = parseLimit(formField(body, name));
    if (limit !== undefined) limits[name.slice(SEND_LIMIT_FIELD_PREFIX.length)] = limit;
  }
  return limits;
}

async function sendError(reply: FastifyReply, status: number, message: string) {
  await reply.code(status).type('text/plain; charset=utf-8').send(message);
}

function storedSettings(row: MailboxSettingsRow) {
  return {
    emailAddress: row.email_address,
    aliases: row.aliases,
    displayName: row.display_name,
    microsoftTenantId: row.microsoft_tenant_id,
    routingPriority: row.routing_priority,
    perRunDraftLimit: row.per_run_draft_limit,
    dailyDraftLimit: row.daily_draft_limit,
    dailySendLimit: row.daily_send_limit,
    dailySendLimitsByIdentity: row.daily_send_limits_by_identity,
    enabled: row.enabled,
  };
}

/** One owner per address, with the same rule as the seed. */
function addressConflict(record: MailboxRecord, rows: readonly MailboxSettingsRow[]) {
  return mailboxAddressConflict(
    record,
    rows.map((row): MailboxAddresses => ({
      id: row.id,
      emailAddress: row.email_address,
      aliases: row.aliases,
    })),
  );
}

function accountOf(row: MailboxSettingsRow) {
  return {
    provider: row.provider,
    emailAddress: row.email_address,
    microsoftTenantId: row.microsoft_tenant_id,
  };
}

/** Field names only: the audit trail must not carry addresses. */
function changedFields(record: MailboxRecord, row: MailboxSettingsRow): string[] {
  const before = storedSettings(row);
  // The account fields with the lock's own rule, so the audit trail and the
  // lock never disagree about what changed.
  const account = changedAccountFields(record, accountOf(row));
  const changes: string[] = [];
  if (account.includes('provider')) changes.push('provider');
  if (account.includes('emailAddress')) changes.push('emailAddress');
  const storedAliases = mailboxIdentities('', row.aliases);
  if (record.aliases.join(',') !== storedAliases.join(',')) changes.push('aliases');
  if (record.displayName !== before.displayName) changes.push('displayName');
  if (account.includes('microsoftTenantId')) changes.push('microsoftTenantId');
  if (record.perRunDraftLimit !== before.perRunDraftLimit) changes.push('perRunDraftLimit');
  if (record.dailyDraftLimit !== before.dailyDraftLimit) changes.push('dailyDraftLimit');
  if (
    JSON.stringify(record.dailySendLimitsByIdentity) !==
    JSON.stringify(before.dailySendLimitsByIdentity)
  ) {
    changes.push('sendLimits');
  }
  return changes;
}

export function registerMailboxAdminRoutes(
  app: FastifyInstance,
  dependencies: MailboxAdminDependencies,
): void {
  const { database, audit, preHandler, rateLimit } = dependencies;

  async function loadMailboxSettings(): Promise<MailboxSettingsRow[]> {
    const result = await database.execute<MailboxSettingsRow>(sql`
      SELECT
        m.id,
        m.provider,
        m.email_address,
        m.aliases,
        m.display_name,
        m.microsoft_tenant_id,
        m.routing_priority,
        m.per_run_draft_limit,
        m.daily_draft_limit,
        m.daily_send_limit,
        m.daily_send_limits_by_identity,
        m.enabled,
        ${mailboxHasOAuthConnection(sql`m.id`)} AS has_oauth_connection
      FROM ${mailboxes} m
      ORDER BY m.routing_priority, m.id
    `);
    return result.rows;
  }

  app.post('/admin/mailboxes', {
    config: rateLimit,
    preHandler,
    async handler(request, reply) {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const input: MailboxRegistryEntryInput = {
        id: formField(body, 'id') ?? '',
        provider: (formField(body, 'provider') ?? '') as MailboxProvider,
        emailAddress: formField(body, 'emailAddress') ?? '',
        aliases: parseAliases(formField(body, 'aliases')),
      };
      const displayName = optionalText(body, 'displayName');
      if (displayName !== undefined) input.displayName = displayName;
      const tenant = optionalText(body, 'microsoftTenantId');
      if (tenant !== undefined) input.microsoftTenantId = tenant;

      const parsed = mailboxRegistryEntrySchema.safeParse(input);
      if (!parsed.success) {
        await sendError(
          reply,
          400,
          `The mailbox was not added:\n${formatRegistryIssues(parsed.error)}`,
        );
        return;
      }
      const rows = await loadMailboxSettings();
      if (rows.some((row) => row.id === parsed.data.id)) {
        await sendError(reply, 409, `A mailbox with the ID ${parsed.data.id} already exists.`);
        return;
      }
      // New mailboxes go last in the routing order until the operator says otherwise.
      const nextPriority = Math.max(0, ...rows.map((row) => row.routing_priority)) + 1;
      const record = resolveMailboxRecord(parsed.data, undefined, nextPriority);
      const conflict = addressConflict(record, rows);
      if (conflict) {
        await sendError(reply, 409, `The mailbox was not added: ${conflict}`);
        return;
      }

      // ON CONFLICT covers a concurrent create of the same id since the read.
      const inserted = await database.execute<{ id: string }>(sql`
        INSERT INTO ${mailboxes} (
          id, provider, email_address, aliases, display_name, microsoft_tenant_id,
          enabled, connection_status, per_run_draft_limit, daily_draft_limit,
          daily_send_limit, daily_send_limits_by_identity, routing_priority
        ) VALUES (
          ${record.id}, ${record.provider}, ${record.emailAddress}, ${sql.param(record.aliases)},
          ${record.displayName}, ${record.microsoftTenantId}, ${record.enabled}, 'disconnected',
          ${record.perRunDraftLimit}, ${record.dailyDraftLimit}, ${record.dailySendLimit},
          ${JSON.stringify(record.dailySendLimitsByIdentity)}::jsonb, ${record.routingPriority}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `);
      if (inserted.rows.length === 0) {
        await sendError(reply, 409, `A mailbox with the ID ${record.id} already exists.`);
        return;
      }
      await audit.write({
        correlationId: request.id,
        mailboxId: record.id,
        operation: 'mailbox_create',
        result: 'succeeded',
        metadata: { provider: record.provider, aliasCount: record.aliases.length },
      });
      await reply.redirect('/admin', 303);
    },
  });

  app.post('/admin/mailboxes/:mailboxId/update', {
    config: rateLimit,
    preHandler,
    async handler(request, reply) {
      const { mailboxId } = request.params as { mailboxId: string };
      const rows = await loadMailboxSettings();
      const current = rows.find((row) => row.id === mailboxId);
      if (!current) {
        await sendError(reply, 404, 'Mailbox not found.');
        return;
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      // A field the form does not send keeps its stored value: locked fields
      // are not rendered as inputs at all.
      const provider = (formField(body, 'provider')?.trim() ?? current.provider) as MailboxProvider;
      const emailAddress = formField(body, 'emailAddress') ?? current.email_address;
      const tenantField = formField(body, 'microsoftTenantId');
      const aliases =
        formField(body, 'aliases') === undefined
          ? current.aliases
          : parseAliases(formField(body, 'aliases'));
      // Limits of identities removed in the same submit are dropped, not
      // reported: their inputs were on the page the operator just edited.
      const identities = new Set(mailboxIdentities(emailAddress, aliases));
      const sendLimits = Object.fromEntries(
        Object.entries(parseSendLimits(body)).filter(([identity]) =>
          identities.has(identity.trim().toLowerCase()),
        ),
      ) as Record<string, number>;
      const input: MailboxRegistryEntryInput = {
        id: current.id,
        provider,
        emailAddress,
        aliases,
        sendLimits,
      };
      // A cleared tenant input clears the pin. Outside Microsoft the input is
      // ignored: the editor always posts it, and a pin left in it while
      // switching provider must clear, not fail validation.
      if (provider !== 'microsoft') {
        input.microsoftTenantId = null;
      } else if (tenantField !== undefined) {
        input.microsoftTenantId = tenantField.trim() ? tenantField : null;
      }
      const displayName = optionalText(body, 'displayName');
      if (displayName !== undefined) input.displayName = displayName;
      const perRunDraftLimit = parseLimit(formField(body, 'perRunDraftLimit'));
      if (perRunDraftLimit !== undefined) input.perRunDraftLimit = perRunDraftLimit as number;
      const dailyDraftLimit = parseLimit(formField(body, 'dailyDraftLimit'));
      if (dailyDraftLimit !== undefined) input.dailyDraftLimit = dailyDraftLimit as number;

      const parsed = mailboxRegistryEntrySchema.safeParse(input);
      if (!parsed.success) {
        await sendError(
          reply,
          400,
          `The changes were not saved:\n${formatRegistryIssues(parsed.error)}`,
        );
        return;
      }
      const record = resolveMailboxRecord(
        parsed.data,
        storedSettings(current),
        current.routing_priority,
      );
      const changes = changedFields(record, current);
      const touchesAccount = changes.some((field) =>
        ['provider', 'emailAddress', 'microsoftTenantId'].includes(field),
      );
      if (lockedAccountChanges(record, accountOf(current), current.has_oauth_connection).length) {
        await sendError(reply, 409, `The changes were not saved. ${LOCKED_EXPLANATION}`);
        return;
      }
      const conflict = addressConflict(record, rows);
      if (conflict) {
        await sendError(reply, 409, `The changes were not saved: ${conflict}`);
        return;
      }

      // Unchanged addresses keep their stored spelling: identities are compared
      // case-insensitively, but a save must not rewrite what it did not change.
      const emailAddressToStore = changes.includes('emailAddress')
        ? record.emailAddress
        : current.email_address;
      const aliasesToStore = changes.includes('aliases') ? record.aliases : current.aliases;
      // The lock is checked again in the statement: an OAuth callback may have
      // stored a connection since the read above.
      const accountUnlocked = touchesAccount
        ? sql`AND NOT ${mailboxHasOAuthConnection(record.id)}`
        : sql``;
      const updated = await database.execute<{ id: string }>(sql`
        UPDATE ${mailboxes}
        SET provider = ${record.provider},
            email_address = ${emailAddressToStore},
            aliases = ${sql.param(aliasesToStore)},
            display_name = ${record.displayName},
            microsoft_tenant_id = ${record.microsoftTenantId},
            per_run_draft_limit = ${record.perRunDraftLimit},
            daily_draft_limit = ${record.dailyDraftLimit},
            daily_send_limit = ${record.dailySendLimit},
            daily_send_limits_by_identity = ${JSON.stringify(record.dailySendLimitsByIdentity)}::jsonb,
            updated_at = now()
        WHERE id = ${record.id} ${accountUnlocked}
        RETURNING id
      `);
      if (updated.rows.length === 0) {
        await sendError(reply, 409, `The changes were not saved. ${LOCKED_EXPLANATION}`);
        return;
      }
      await audit.write({
        correlationId: request.id,
        mailboxId: record.id,
        operation: 'mailbox_update',
        result: 'succeeded',
        metadata: { changedFields: changes },
      });
      await reply.redirect('/admin', 303);
    },
  });
}
