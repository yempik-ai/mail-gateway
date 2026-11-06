import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  escapeHtml,
  GatewayError,
  mailboxIdentities,
  type GatewayConfig,
  type MailboxProvider,
  type ProviderSendingIdentity,
} from '@yempik/core';
import {
  auditEvents,
  dailyMailboxUsage,
  listPendingMigrations,
  mailboxes,
  mailboxHasOAuthConnection,
  mcpClients,
  MigrationFailedError,
  runMigrations,
  type Database,
  type MigrationRun,
  type PendingMigrations,
} from '@yempik/database';
import type { AuditWriter } from '@yempik/observability';
import { createAdminWarningsHook } from './admin-warnings.js';
import type { AdapterFactory } from './mail-search.js';
import {
  registerMailboxAdminRoutes,
  renderAddMailboxForm,
  renderMailboxEditor,
  type MailboxSettingsRow,
} from './admin-mailboxes.js';
import { createAdminBasicAuthHook } from './oauth.js';
import {
  createDatabaseSignatureStore,
  type SignatureStore,
  type StoredSignature,
} from './signature-store.js';

export interface AdminDashboardDependencies {
  config: GatewayConfig;
  database: Database;
  audit: AuditWriter;
  adminSecret: string;
  /** Provider adapters; needed only to import Gmail signatures. */
  adapterFactory?: AdapterFactory;
  /** Defaults to the database store; injectable so tests need no Postgres. */
  signatureStore?: SignatureStore;
  /** Defaults to `@yempik/database`; injectable so tests need no Postgres or SQL files. */
  migrations?: MigrationRunner;
  /**
   * The proxy trust the server runs with, which may differ from
   * config.TRUST_PROXY (the serverless entry always trusts Vercel's edge).
   * Defaults to config.TRUST_PROXY.
   */
  trustProxy?: GatewayConfig['TRUST_PROXY'];
}

/**
 * Production runs on Vercel with no shell, so the dashboard is the only place
 * the operator can apply a migration shipped with a deploy.
 */
export interface MigrationRunner {
  listPending(databaseUrl: string): Promise<PendingMigrations>;
  run(databaseUrl: string): Promise<MigrationRun>;
}

const defaultMigrationRunner: MigrationRunner = {
  listPending: (databaseUrl) => listPendingMigrations(databaseUrl),
  run: (databaseUrl) => runMigrations(databaseUrl),
};

/** What the Migrations box shows: the state, or why it could not be read. */
type MigrationStatus = ({ ok: true } & PendingMigrations) | { ok: false; message: string };

interface MailboxRow extends MailboxSettingsRow {
  connection_status: string;
  messages_sent_by_identity: Record<string, number>;
  remaining_daily_capacity: number;
  remaining_daily_send_capacity: number;
  last_successful_read_at: Date | string | null;
  last_successful_draft_at: Date | string | null;
  last_successful_send_at: Date | string | null;
  last_error_code: string | null;
}

/** Mailbox fields the signature routes need to enumerate and check identities. */
interface MailboxIdentityRow extends Record<string, unknown> {
  id: string;
  provider: MailboxProvider;
  email_address: string;
  aliases: string[];
  enabled: boolean;
}

interface AuditRow extends Record<string, unknown> {
  occurred_at: Date | string;
  operation: string;
  result: string;
  error_code: string | null;
  mailbox_id: string | null;
}

const adminRateLimit = { rateLimit: { max: 20, timeWindow: 60_000 } };

/**
 * Connect-flow route segment per provider. Keyed by `MailboxProvider` on
 * purpose: a new provider fails to compile here until its route is declared,
 * rather than silently linking to the wrong one.
 */
const OAUTH_PROVIDER_PATH: Record<MailboxProvider, string> = {
  gmail: 'google',
  microsoft: 'microsoft',
  zoho: 'zoho',
};

/** Table cell text, escaped: a dot stands for a missing value. */
function cell(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '·' : escapeHtml(String(value));
}

function displayTimestamp(value: Date | string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function renderMailboxRow(mailbox: MailboxRow): string {
  const providerPath = OAUTH_PROVIDER_PATH[mailbox.provider];
  const connectionAction = mailbox.connection_status === 'connected' ? 'Reconnect' : 'Connect';
  const encodedMailboxId = encodeURIComponent(mailbox.id);
  const toggleAction = mailbox.enabled ? 'disable' : 'enable';
  const toggleLabel = mailbox.enabled ? 'Disable' : 'Enable';
  const identityCapacity = mailboxIdentities(mailbox.email_address, mailbox.aliases)
    .map((identity) => {
      const limit = mailbox.daily_send_limits_by_identity[identity] ?? mailbox.daily_send_limit;
      const sent = mailbox.messages_sent_by_identity[identity] ?? 0;
      return `${identity}: ${Math.max(limit - sent, 0)}/${limit}`;
    })
    .join(' · ');

  return [
    '<tr>',
    `<td><code>${escapeHtml(mailbox.id)}</code></td>`,
    `<td>${escapeHtml(mailbox.provider)}</td>`,
    `<td>${escapeHtml(mailbox.email_address)}</td>`,
    `<td><span class="status">${escapeHtml(mailbox.connection_status)}</span></td>`,
    `<td>${mailbox.enabled ? 'Yes' : 'No'}</td>`,
    `<td>${cell(mailbox.remaining_daily_capacity)}</td>`,
    `<td>${cell(mailbox.remaining_daily_send_capacity)}</td>`,
    `<td>${cell(identityCapacity)}</td>`,
    `<td>${cell(displayTimestamp(mailbox.last_successful_read_at))}</td>`,
    `<td>${cell(displayTimestamp(mailbox.last_successful_draft_at))}</td>`,
    `<td>${cell(displayTimestamp(mailbox.last_successful_send_at))}</td>`,
    `<td>${cell(mailbox.last_error_code)}</td>`,
    '<td class="actions">',
    `<a href="/oauth/${providerPath}/start?mailboxId=${escapeHtml(encodedMailboxId)}">${connectionAction}</a>`,
    `<form method="post" action="/admin/mailboxes/${escapeHtml(encodedMailboxId)}/${toggleAction}">`,
    `<button type="submit">${toggleLabel}</button>`,
    '</form>',
    renderMailboxEditor(mailbox),
    '</td></tr>',
  ].join('');
}

function signatureKey(mailboxId: string, identityEmail: string): string {
  return `${mailboxId}\u0000${identityEmail}`;
}

function renderSignatureStatus(signature: StoredSignature | undefined): string {
  if (!signature || (!signature.signatureHtml && !signature.signatureText)) return 'No';
  const origin = signature.source === 'gmail' ? 'from Gmail' : 'manual';
  const synced = signature.syncedAt ? `, imported ${signature.syncedAt}` : '';
  return `Yes (${origin}${synced})`;
}

function renderSignatureRows(
  mailbox: MailboxIdentityRow,
  signatures: ReadonlyMap<string, StoredSignature>,
): string {
  const encodedMailboxId = encodeURIComponent(mailbox.id);
  return mailboxIdentities(mailbox.email_address, mailbox.aliases)
    .map((identity, index) => {
      const signature = signatures.get(signatureKey(mailbox.id, identity));
      const hasContent = Boolean(signature?.signatureHtml ?? signature?.signatureText);
      const encodedIdentity = encodeURIComponent(identity);
      // One import button per mailbox: the import covers all its identities.
      const importForm =
        mailbox.provider === 'gmail' && index === 0
          ? [
              `<form method="post" action="/admin/signatures/${escapeHtml(encodedMailboxId)}/sync-gmail">`,
              '<button type="submit">Import from Gmail</button></form>',
            ].join('')
          : '';
      const applyAllForm = hasContent
        ? [
            '<form method="post" action="/admin/signatures/apply-all">',
            `<input type="hidden" name="sourceMailboxId" value="${escapeHtml(mailbox.id)}">`,
            `<input type="hidden" name="sourceIdentityEmail" value="${escapeHtml(identity)}">`,
            '<button type="submit">Apply to every identity</button></form>',
          ].join('')
        : '';
      return [
        '<tr>',
        `<td><code>${escapeHtml(mailbox.id)}</code></td>`,
        `<td>${escapeHtml(identity)}</td>`,
        `<td>${escapeHtml(mailbox.provider)}</td>`,
        `<td>${cell(signature?.displayName)}</td>`,
        `<td>${escapeHtml(renderSignatureStatus(signature))}</td>`,
        '<td>',
        `<form class="signature-form" method="post" action="/admin/signatures/${escapeHtml(encodedMailboxId)}/${escapeHtml(encodedIdentity)}">`,
        `<label>Sender name <input type="text" name="displayName" value="${signature?.displayName ? escapeHtml(signature.displayName) : ''}"></label>`,
        // Escaped, never rendered: the dashboard must not execute stored HTML.
        `<label>Signature (HTML) <textarea name="signatureHtml" rows="4">${signature?.signatureHtml ? escapeHtml(signature.signatureHtml) : ''}</textarea></label>`,
        '<button type="submit">Save signature</button></form></td>',
        `<td class="actions">${importForm}${applyAllForm}</td>`,
        '</tr>',
      ].join('');
    })
    .join('');
}

function renderSignatureSection(
  mailboxRows: readonly MailboxIdentityRow[],
  signatures: readonly StoredSignature[] | undefined,
): string {
  // Undefined when the table cannot be read, typically between a deploy that
  // ships migration 0008 and the operator applying it from the box above.
  if (signatures === undefined) {
    return [
      '<section><h2>Signatures</h2>',
      '<p class="warning">The signatures table does not exist yet. Apply the pending migrations above.</p>',
      '</section>',
    ].join('');
  }
  const byIdentity = new Map(
    signatures.map((signature) => [
      signatureKey(signature.mailboxId, signature.identityEmail),
      signature,
    ]),
  );
  const rows = mailboxRows
    .filter((mailbox) => mailbox.enabled)
    .map((mailbox) => renderSignatureRows(mailbox, byIdentity))
    .join('');
  return [
    '<section><h2>Signatures</h2>',
    '<p>Provider APIs do not add your signature to drafts. The gateway adds the one saved here ',
    'for each sending identity. For Gmail, use <strong>Import from Gmail</strong>. For Microsoft ',
    'and Zoho, paste the signature HTML. With an empty signature, only the sender name is saved. ',
    'Clearing both fields deletes the saved row.</p>',
    '<p><strong>Apply to every identity</strong> copies this signature and sender name to every ',
    'other identity of the enabled mailboxes. It also replaces signatures imported from Gmail, ',
    'which become manual signatures.</p>',
    '<table><thead><tr>',
    '<th>Mailbox</th><th>Identity</th><th>Provider</th><th>Sender name</th>',
    '<th>Saved signature</th><th>Edit</th><th>Actions</th>',
    `</tr></thead><tbody>${rows || '<tr><td colspan="7">No enabled mailboxes.</td></tr>'}</tbody></table></section>`,
  ].join('');
}

function renderMigrationSection(status: MigrationStatus): string {
  if (!status.ok) {
    return [
      '<section><h2>Migrations</h2>',
      `<p class="warning">Cannot read the migration status: ${escapeHtml(status.message)}</p>`,
      '</section>',
    ].join('');
  }
  const summary = `<p>Directory: <code>${escapeHtml(status.directory)}</code> · Applied: <strong>${status.applied.length}</strong></p>`;
  if (status.pending.length === 0) {
    return `<section><h2>Migrations</h2>${summary}<p class="off">No pending migrations.</p></section>`;
  }
  const pendingItems = status.pending
    .map((version) => `<li><code>${escapeHtml(version)}</code></li>`)
    .join('');
  return [
    '<section><h2>Migrations</h2>',
    summary,
    `<div class="warning"><p>Pending: <strong>${status.pending.length}</strong></p>`,
    `<ul>${pendingItems}</ul>`,
    '<form method="post" action="/admin/migrations/apply">',
    '<button type="submit">Apply pending migrations</button></form></div></section>',
  ].join('');
}

function renderAuditRow(event: AuditRow): string {
  return [
    '<tr>',
    `<td>${escapeHtml(displayTimestamp(event.occurred_at))}</td>`,
    `<td>${escapeHtml(event.operation)}</td>`,
    `<td>${escapeHtml(event.result)}</td>`,
    `<td>${cell(event.error_code)}</td>`,
    `<td>${cell(event.mailbox_id)}</td>`,
    '</tr>',
  ].join('');
}

function renderDashboard(
  mailboxRows: MailboxRow[],
  signatures: StoredSignature[] | undefined,
  migrationStatus: MigrationStatus,
  killSwitchActive: boolean,
  events: AuditRow[],
) {
  const killAction = killSwitchActive ? 'deactivate' : 'activate';
  const killLabel = killSwitchActive ? 'Turn off kill switch' : 'Turn on kill switch';
  const mailboxBody = mailboxRows.length
    ? mailboxRows.map(renderMailboxRow).join('')
    : '<tr><td colspan="13">No mailboxes yet.</td></tr>';
  const auditBody = events.length
    ? events.map(renderAuditRow).join('')
    : '<tr><td colspan="5">No events yet.</td></tr>';

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Yempik Mail Gateway · Admin</title>',
    '<style>',
    ':root{color-scheme:light;font-family:system-ui,sans-serif;color:#172033;background:#f5f7fa}',
    'body{max-width:96rem;margin:0 auto;padding:2rem}h1,h2{line-height:1.2}',
    'section{background:#fff;border:1px solid #dce2ea;border-radius:.6rem;padding:1rem;margin:1rem 0;overflow:auto}',
    'table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border-bottom:1px solid #e5e9ef;padding:.55rem;text-align:left;white-space:nowrap}',
    'th{background:#f8fafc}form{display:inline}button,a{font:inherit}button{cursor:pointer;padding:.35rem .65rem}',
    '.actions{display:flex;gap:.7rem;align-items:center}.on{color:#a11919}.off{color:#176b3a}.status{font-weight:600}',
    '.signature-form{display:flex;flex-direction:column;gap:.35rem}.signature-form textarea{min-width:28rem;font-family:ui-monospace,monospace}',
    '.warning{background:#fff6e5;border:1px solid #f0c36d;border-radius:.4rem;padding:.6rem .8rem;color:#6b4500}',
    'form.mailbox-form{display:grid;gap:.45rem;max-width:34rem;white-space:normal;margin:.5rem 0}',
    '.mailbox-form label{display:grid;gap:.15rem}.mailbox-form fieldset{display:grid;gap:.35rem}',
    '.note{color:#4a5568;font-size:.85rem;white-space:normal}',
    '</style></head><body>',
    '<h1>Yempik Mail Gateway</h1><p>Operator dashboard for mailboxes, drafts and controlled sending.</p>',
    '<section><h2>Kill switch</h2>',
    '<p>When on, every MCP client is blocked: no reads, drafts or sends.</p>',
    `<p class="${killSwitchActive ? 'on' : 'off'}">Status: <strong>${killSwitchActive ? 'ON' : 'OFF'}</strong></p>`,
    '<form method="post" action="/admin/kill-switch">',
    `<input type="hidden" name="action" value="${killAction}">`,
    `<button type="submit">${killLabel}</button></form></section>`,
    renderMigrationSection(migrationStatus),
    '<section><h2>Mailboxes</h2><table><thead><tr>',
    '<th>ID</th><th>Provider</th><th>Address</th><th>Connection</th><th>Enabled</th>',
    '<th>Drafts left today</th><th>Sends left today</th><th>Sends left per identity</th><th>Last read</th><th>Last draft</th><th>Last send</th>',
    '<th>Last error</th><th>Actions</th>',
    `</tr></thead><tbody>${mailboxBody}</tbody></table>`,
    renderAddMailboxForm(),
    '</section>',
    renderSignatureSection(mailboxRows, signatures),
    '<section><h2>Last 20 audit events</h2><table><thead><tr>',
    '<th>Time</th><th>Operation</th><th>Result</th><th>Error code</th><th>Mailbox</th>',
    `</tr></thead><tbody>${auditBody}</tbody></table></section>`,
    '</body></html>',
  ].join('');
}

/** A form-encoded field; repeated fields (an array) are rejected as absent. */
function formField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Postgres SQLSTATE (e.g. 42P01) or Node error code, when there is one. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

async function sendAdminError(reply: FastifyReply, status: number, message: string) {
  await reply.code(status).type('text/plain; charset=utf-8').send(message);
}

export function registerAdminDashboard(
  app: FastifyInstance,
  dependencies: AdminDashboardDependencies,
): void {
  const { config, database, audit, adminSecret, adapterFactory } = dependencies;
  const requireAdmin = createAdminBasicAuthHook(adminSecret);
  const signatureStore = dependencies.signatureStore ?? createDatabaseSignatureStore(database);
  const migrations = dependencies.migrations ?? defaultMigrationRunner;

  async function loadMailboxIdentities(): Promise<MailboxIdentityRow[]> {
    const result = await database.execute<MailboxIdentityRow>(sql`
      SELECT id, provider, email_address, aliases, enabled
      FROM ${mailboxes}
      ORDER BY routing_priority, id
    `);
    return result.rows;
  }

  app.get('/admin', {
    config: adminRateLimit,
    preHandler: requireAdmin,
    onSend: createAdminWarningsHook(adminSecret, dependencies.trustProxy ?? config.TRUST_PROXY),
    async handler(request, reply) {
      const mailboxResult = await database.execute<MailboxRow>(sql`
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
          m.connection_status,
          m.enabled,
          m.daily_send_limit,
          m.daily_send_limits_by_identity,
          ${mailboxHasOAuthConnection(sql`m.id`)} AS has_oauth_connection,
          coalesce(u.messages_sent_by_identity, '{}'::jsonb) AS messages_sent_by_identity,
          greatest(m.daily_draft_limit - coalesce(u.drafts_created, 0), 0)::int
            AS remaining_daily_capacity,
          greatest(m.daily_send_limit - coalesce(u.messages_sent, 0), 0)::int
            AS remaining_daily_send_capacity,
          m.last_successful_read_at,
          m.last_successful_draft_at,
          m.last_successful_send_at,
          m.last_error_code
        FROM ${mailboxes} m
        LEFT JOIN ${dailyMailboxUsage} u
          ON u.mailbox_id = m.id AND u.usage_date = current_date
        ORDER BY m.routing_priority, m.id
      `);
      const killSwitchResult = await database.execute<{ active: boolean }>(sql`
        SELECT coalesce(bool_or(${mcpClients.globalKillSwitch}), false) AS active
        FROM ${mcpClients}
      `);
      // Neither box may take the page down: the page is how the operator
      // reaches the migrate button that fixes the usual cause of both failures.
      let signatures: StoredSignature[] | undefined;
      try {
        signatures = await signatureStore.listSignatures();
      } catch (error) {
        request.log.warn(
          { code: errorCode(error), message: errorMessage(error) },
          'admin dashboard: signatures unavailable',
        );
      }
      let migrationStatus: MigrationStatus;
      try {
        migrationStatus = { ok: true, ...(await migrations.listPending(config.DATABASE_URL)) };
      } catch (error) {
        request.log.warn(
          { code: errorCode(error), message: errorMessage(error) },
          'admin dashboard: migration status unavailable',
        );
        migrationStatus = { ok: false, message: errorMessage(error) };
      }
      const auditResult = await database.execute<AuditRow>(sql`
        SELECT occurred_at, operation, result, error_code, mailbox_id
        FROM ${auditEvents}
        ORDER BY occurred_at DESC
        LIMIT 20
      `);

      await reply
        .type('text/html; charset=utf-8')
        .send(
          renderDashboard(
            mailboxResult.rows,
            signatures,
            migrationStatus,
            killSwitchResult.rows[0]?.active ?? false,
            auditResult.rows,
          ),
        );
    },
  });

  const registerMailboxToggle = (action: 'enable' | 'disable', enabled: boolean) => {
    app.post(`/admin/mailboxes/:mailboxId/${action}`, {
      config: adminRateLimit,
      preHandler: requireAdmin,
      async handler(request, reply) {
        const { mailboxId } = request.params as { mailboxId: string };
        await database.execute(sql`
          UPDATE ${mailboxes}
          SET enabled = ${enabled}, updated_at = now()
          WHERE id = ${mailboxId}
        `);
        await audit.write({
          correlationId: request.id,
          mailboxId,
          operation: 'admin_mailbox_toggle',
          result: 'succeeded',
          metadata: { enabled },
        });
        await reply.redirect('/admin', 303);
      },
    });
  };

  registerMailboxToggle('enable', true);
  registerMailboxToggle('disable', false);
  registerMailboxAdminRoutes(app, {
    database,
    audit,
    preHandler: requireAdmin,
    rateLimit: adminRateLimit,
  });

  app.post('/admin/kill-switch', {
    config: adminRateLimit,
    preHandler: requireAdmin,
    async handler(request, reply) {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (body.action !== 'activate' && body.action !== 'deactivate') {
        await reply.code(400).send({ error: 'action must be activate or deactivate' });
        return;
      }
      const active = body.action === 'activate';
      await database.execute(sql`
        UPDATE ${mcpClients}
        SET global_kill_switch = ${active}, updated_at = now()
      `);
      await audit.write({
        correlationId: request.id,
        operation: 'admin_kill_switch',
        result: 'succeeded',
        metadata: { active },
      });
      await reply.redirect('/admin', 303);
    },
  });

  app.post('/admin/migrations/apply', {
    config: adminRateLimit,
    preHandler: requireAdmin,
    async handler(request, reply) {
      let run: MigrationRun;
      try {
        run = await migrations.run(config.DATABASE_URL);
      } catch (error) {
        // Each file runs in its own transaction: earlier files stay applied.
        const applied = error instanceof MigrationFailedError ? [...error.applied] : [];
        // Best effort: when the database is unreachable the audit write fails
        // too, and the operator still needs the original error on the page.
        await audit
          .write({
            correlationId: request.id,
            operation: 'migrations_apply',
            result: 'failed',
            errorCode: 'DATABASE_ERROR',
            metadata: {
              applied,
              ...(error instanceof MigrationFailedError
                ? { failedVersion: error.failedVersion }
                : {}),
            },
          })
          .catch((auditError: unknown) => {
            request.log.warn(
              { code: errorCode(auditError), message: errorMessage(auditError) },
              'admin dashboard: migrations_apply audit failed',
            );
          });
        const progress = applied.length
          ? ` Migrations applied before the error: ${applied.join(', ')}.`
          : '';
        await sendAdminError(
          reply,
          500,
          `The migrations could not be applied: ${errorMessage(error)}.${progress}`,
        );
        return;
      }
      await audit.write({
        correlationId: request.id,
        operation: 'migrations_apply',
        result: 'succeeded',
        metadata: { applied: run.applied },
      });
      await reply.redirect('/admin', 303);
    },
  });

  // Registered before the `:identityEmail` route for readability only: static
  // segments always win over parameters in the router.
  app.post('/admin/signatures/apply-all', {
    config: adminRateLimit,
    preHandler: requireAdmin,
    async handler(request, reply) {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const sourceMailboxId = formField(body, 'sourceMailboxId')?.trim();
      const sourceIdentity = formField(body, 'sourceIdentityEmail')?.trim().toLowerCase();
      if (!sourceMailboxId || !sourceIdentity) {
        await sendAdminError(
          reply,
          400,
          'Choose the mailbox and identity of the signature to apply.',
        );
        return;
      }
      const source = await signatureStore.getSignature(sourceMailboxId, sourceIdentity);
      if (!source || (!source.signatureHtml && !source.signatureText)) {
        await sendAdminError(reply, 400, 'No signature is saved for this identity.');
        return;
      }

      // Deliberately an overwrite of every other identity of every enabled
      // mailbox, imported ones included: predictable beats clever here, and
      // the dashboard says so next to the button. The store does it in one
      // statement, so a failure overwrites nothing rather than a prefix.
      const { updatedIdentities } = await signatureStore.applySignatureToAllIdentities({
        sourceMailboxId,
        sourceIdentityEmail: sourceIdentity,
        displayName: source.displayName,
        signatureHtml: source.signatureHtml,
        signatureText: source.signatureText,
      });

      await audit.write({
        correlationId: request.id,
        mailboxId: sourceMailboxId,
        operation: 'signature_apply_all',
        result: 'succeeded',
        metadata: { sourceIdentityEmail: sourceIdentity, updatedIdentities },
      });
      await reply.redirect('/admin', 303);
    },
  });

  app.post('/admin/signatures/:mailboxId/sync-gmail', {
    config: adminRateLimit,
    preHandler: requireAdmin,
    async handler(request, reply) {
      const { mailboxId } = request.params as { mailboxId: string };
      const mailbox = (await loadMailboxIdentities()).find((row) => row.id === mailboxId);
      if (!mailbox) {
        await sendAdminError(reply, 404, 'Mailbox not found.');
        return;
      }
      if (mailbox.provider !== 'gmail') {
        await sendAdminError(
          reply,
          400,
          'Signature import works only for Gmail mailboxes. For Microsoft and Zoho, paste the signature by hand.',
        );
        return;
      }
      const adapter = adapterFactory?.(
        {
          id: mailbox.id,
          provider: mailbox.provider,
          emailAddress: mailbox.email_address,
          aliases: mailbox.aliases,
        },
        request.id,
      );
      if (!adapter?.listSendingIdentities) {
        await sendAdminError(
          reply,
          400,
          'Cannot import from Gmail: the Gmail adapter is not configured or does not list sending identities.',
        );
        return;
      }

      let providerIdentities: ProviderSendingIdentity[];
      try {
        providerIdentities = await adapter.listSendingIdentities();
      } catch (error) {
        const errorCode = error instanceof GatewayError ? error.code : 'INTERNAL_ERROR';
        await audit.write({
          correlationId: request.id,
          mailboxId,
          operation: 'signature_sync_gmail',
          result: 'failed',
          errorCode,
        });
        await sendAdminError(
          reply,
          502,
          `Gmail did not return the sending identities (${errorCode}). Check the mailbox connection.`,
        );
        return;
      }

      // Only identities the gateway may send from: a send-as address that is
      // not registered as the mailbox address or alias is ignored.
      const allowed = new Set(mailboxIdentities(mailbox.email_address, mailbox.aliases));
      const importedIdentities: string[] = [];
      for (const identity of providerIdentities) {
        const identityEmail = identity.emailAddress.trim().toLowerCase();
        if (!allowed.has(identityEmail)) continue;
        await signatureStore.upsertSignature({
          mailboxId,
          identityEmail,
          displayName: identity.displayName,
          signatureHtml: identity.signatureHtml,
          source: 'gmail',
        });
        importedIdentities.push(identityEmail);
      }

      await audit.write({
        correlationId: request.id,
        mailboxId,
        operation: 'signature_sync_gmail',
        result: 'succeeded',
        metadata: {
          importedIdentities,
          ignoredIdentities: providerIdentities.length - importedIdentities.length,
        },
      });
      await reply.redirect('/admin', 303);
    },
  });

  app.post('/admin/signatures/:mailboxId/:identityEmail', {
    config: adminRateLimit,
    preHandler: requireAdmin,
    async handler(request, reply) {
      const params = request.params as { mailboxId: string; identityEmail: string };
      const { mailboxId } = params;
      const identityEmail = params.identityEmail.trim().toLowerCase();
      const mailbox = (await loadMailboxIdentities()).find((row) => row.id === mailboxId);
      if (!mailbox) {
        await sendAdminError(reply, 404, 'Mailbox not found.');
        return;
      }
      if (
        !identityEmail ||
        !mailboxIdentities(mailbox.email_address, mailbox.aliases).includes(identityEmail)
      ) {
        await sendAdminError(
          reply,
          400,
          'This identity is neither the address nor an alias of the mailbox.',
        );
        return;
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const displayName = formField(body, 'displayName')?.trim() || undefined;
      const signatureHtml = formField(body, 'signatureHtml')?.trim() || undefined;
      // A display name alone is a valid row (Gmail identities imported without
      // a signature have exactly that shape), so only a form with both fields
      // empty removes the row.
      const action = displayName || signatureHtml ? 'upserted' : 'deleted';
      if (action === 'deleted') {
        await signatureStore.deleteSignature(mailboxId, identityEmail);
      } else {
        await signatureStore.upsertSignature({
          mailboxId,
          identityEmail,
          // An empty field is stored as a NULL column.
          displayName,
          signatureHtml,
          // A new HTML invalidates any stored text part: the renderer derives it.
          source: 'manual',
        });
      }

      await audit.write({
        correlationId: request.id,
        mailboxId,
        operation: 'signature_update',
        result: 'succeeded',
        metadata: { identityEmail, action },
      });
      await reply.redirect('/admin', 303);
    },
  });
}
