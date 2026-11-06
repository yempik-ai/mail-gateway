import type {
  GatewayConfig,
  MailProviderAdapter,
  ProviderSendingIdentity,
} from '../../packages/core/src/index.js';
import type { Database } from '../../packages/database/src/index.js';
import type { AuditEventInput, AuditWriter } from '../../packages/observability/src/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { SQL } from '../../apps/mcp-server/node_modules/drizzle-orm/index.js';
import { PgDialect } from '../../apps/mcp-server/node_modules/drizzle-orm/pg-core/index.js';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  registerAdminDashboard,
  type MigrationRunner,
} from '../../apps/mcp-server/src/admin-dashboard.js';
import type { AdapterFactory } from '../../apps/mcp-server/src/mail-search.js';
import type {
  ApplySignatureToAllInput,
  SignatureStore,
  StoredSignature,
  UpsertSignatureInput,
} from '../../apps/mcp-server/src/signature-store.js';

const ADMIN_SECRET = 'dashboard-secret-longer-than-sixteen';
const DATABASE_URL = 'postgres://stub.invalid/gateway';

function basicHeader(password: string): string {
  return `Basic ${Buffer.from(`admin:${password}`, 'utf8').toString('base64')}`;
}

const MAILBOX_ROWS = [
  {
    id: 'primary-gmail',
    provider: 'gmail',
    email_address: 'outreach@example.com',
    aliases: [],
    connection_status: 'connected',
    enabled: true,
    display_name: 'Example Outreach',
    microsoft_tenant_id: null,
    routing_priority: 1,
    per_run_draft_limit: 5,
    daily_draft_limit: 25,
    has_oauth_connection: true,
    daily_send_limit: 15,
    daily_send_limits_by_identity: { 'outreach@example.com': 15 },
    messages_sent_by_identity: { 'outreach@example.com': 4 },
    remaining_daily_capacity: 21,
    remaining_daily_send_capacity: 11,
    last_successful_read_at: '2026-08-07T08:00:00.000Z',
    last_successful_draft_at: '2026-08-07T08:05:00.000Z',
    last_successful_send_at: '2026-08-07T08:06:00.000Z',
    last_error_code: null,
  },
  {
    id: 'sales-outlook',
    provider: 'microsoft',
    email_address: 'hello@corp.example.com',
    aliases: ['alex@corp.example.com'],
    connection_status: 'connected',
    enabled: true,
    display_name: 'Example Sales',
    microsoft_tenant_id: null,
    routing_priority: 2,
    per_run_draft_limit: 5,
    daily_draft_limit: 25,
    has_oauth_connection: true,
    daily_send_limit: 55,
    daily_send_limits_by_identity: {
      'hello@corp.example.com': 40,
      'alex@corp.example.com': 15,
    },
    messages_sent_by_identity: {},
    remaining_daily_capacity: 25,
    remaining_daily_send_capacity: 55,
    last_successful_read_at: null,
    last_successful_draft_at: null,
    last_successful_send_at: null,
    last_error_code: null,
  },
  {
    id: 'team-zoho',
    provider: 'zoho',
    email_address: 'outreach@zoho.example.com',
    aliases: [],
    connection_status: 'disconnected',
    enabled: true,
    display_name: 'Example Team',
    microsoft_tenant_id: null,
    routing_priority: 3,
    per_run_draft_limit: 5,
    daily_draft_limit: 25,
    has_oauth_connection: false,
    daily_send_limit: 25,
    daily_send_limits_by_identity: { 'outreach@zoho.example.com': 25 },
    messages_sent_by_identity: {},
    remaining_daily_capacity: 25,
    remaining_daily_send_capacity: 25,
    last_successful_read_at: null,
    last_successful_draft_at: null,
    last_successful_send_at: null,
    last_error_code: null,
  },
  {
    id: 'disabled-outlook',
    provider: 'microsoft',
    email_address: 'old@corp.example.com',
    aliases: [],
    connection_status: 'connected',
    enabled: false,
    display_name: 'Old',
    microsoft_tenant_id: null,
    routing_priority: 4,
    per_run_draft_limit: 5,
    daily_draft_limit: 25,
    has_oauth_connection: true,
    daily_send_limit: 25,
    daily_send_limits_by_identity: {},
    messages_sent_by_identity: {},
    remaining_daily_capacity: 25,
    remaining_daily_send_capacity: 25,
    last_successful_read_at: null,
    last_successful_draft_at: null,
    last_successful_send_at: null,
    last_error_code: null,
  },
];

type MailboxFixture = Omit<
  (typeof MAILBOX_ROWS)[number],
  'microsoft_tenant_id' | 'daily_send_limits_by_identity'
> & {
  microsoft_tenant_id: string | null;
  daily_send_limits_by_identity: Record<string, number>;
};

interface ExecutedStatement {
  sql: string;
  params: unknown[];
}

// Answers each statement by what it reads, so routes may issue their queries
// in any order. Statements are recorded; mailbox writes with RETURNING report
// one written row unless `mailboxWritesMatch` is false (a lost race).
function createDatabaseStub(
  statements: ExecutedStatement[] = [],
  options: { mailboxWritesMatch?: boolean; mailboxRows?: readonly MailboxFixture[] } = {},
): Database {
  const dialect = new PgDialect();
  return {
    execute(query: SQL) {
      const { sql: statement, params } = dialect.sqlToQuery(query);
      statements.push({ sql: statement, params });
      if (statement.includes('global_kill_switch') && statement.includes('bool_or')) {
        return Promise.resolve({ rows: [{ active: false }] });
      }
      if (statement.includes('"audit_events"')) {
        return Promise.resolve({
          rows: [
            {
              occurred_at: '2026-08-07T08:10:00.000Z',
              operation: 'email_read',
              result: 'succeeded',
              error_code: null,
              mailbox_id: 'primary-gmail',
            },
          ],
        });
      }
      if (statement.trim().startsWith('SELECT') && statement.includes('"mailboxes"')) {
        return Promise.resolve({ rows: options.mailboxRows ?? MAILBOX_ROWS });
      }
      if (isMailboxWrite(statement) && statement.includes('RETURNING')) {
        return Promise.resolve({
          rows: options.mailboxWritesMatch === false ? [] : [{ id: 'written' }],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Database;
}

function isMailboxWrite(statement: string): boolean {
  const trimmed = statement.trim();
  return trimmed.startsWith('INSERT INTO "mailboxes"') || trimmed.startsWith('UPDATE "mailboxes"');
}

// Identities the real apply-all statement would overwrite for the fixture
// mailboxes when the source is outreach@example.com: every other identity of an
// enabled mailbox. The enumeration itself is SQL, covered by the store test.
const OTHER_ENABLED_IDENTITIES = 3;

function createSignatureStoreStub(initial: StoredSignature[] = []) {
  const rows = new Map(initial.map((row) => [`${row.mailboxId}|${row.identityEmail}`, row]));
  const upserts: UpsertSignatureInput[] = [];
  const deletes: string[] = [];
  const applies: ApplySignatureToAllInput[] = [];
  const store: SignatureStore = {
    getSignature: (mailboxId, identityEmail) =>
      Promise.resolve(rows.get(`${mailboxId}|${identityEmail.trim().toLowerCase()}`)),
    listSignatures: () => Promise.resolve([...rows.values()]),
    upsertSignature(input) {
      upserts.push(input);
      const stored: StoredSignature = {
        mailboxId: input.mailboxId,
        identityEmail: input.identityEmail.trim().toLowerCase(),
        source: input.source,
        updatedAt: '2026-11-02T08:00:00.000Z',
        ...(input.signatureHtml === undefined ? {} : { signatureHtml: input.signatureHtml }),
      };
      rows.set(`${stored.mailboxId}|${stored.identityEmail}`, stored);
      return Promise.resolve(stored);
    },
    deleteSignature(mailboxId, identityEmail) {
      deletes.push(`${mailboxId}|${identityEmail}`);
      rows.delete(`${mailboxId}|${identityEmail}`);
      return Promise.resolve();
    },
    applySignatureToAllIdentities(input) {
      applies.push(input);
      return Promise.resolve({ updatedIdentities: OTHER_ENABLED_IDENTITIES });
    },
  };
  return { store, upserts, deletes, applies };
}

function createGmailAdapterFactory(identities: ProviderSendingIdentity[]): AdapterFactory {
  return (mailbox) =>
    ({
      mailboxId: mailbox.id,
      provider: mailbox.provider,
      listSendingIdentities: () => Promise.resolve(identities),
    }) as unknown as MailProviderAdapter;
}

function createAuditStub(events: AuditEventInput[] = []): AuditWriter {
  return {
    write: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

function createMigrationRunnerStub(
  options: { pending?: string[]; listError?: Error; runError?: Error } = {},
) {
  const listCalls: string[] = [];
  const runCalls: string[] = [];
  const pending = options.pending ?? [];
  const runner: MigrationRunner = {
    listPending(databaseUrl) {
      listCalls.push(databaseUrl);
      if (options.listError) return Promise.reject(options.listError);
      return Promise.resolve({
        directory: '/var/task/migrations',
        applied: ['0001_foundation.sql', '0002_mcp_oauth_grants.sql'],
        pending,
      });
    },
    run(databaseUrl) {
      runCalls.push(databaseUrl);
      if (options.runError) return Promise.reject(options.runError);
      return Promise.resolve({ directory: '/var/task/migrations', applied: pending });
    },
  };
  return { runner, listCalls, runCalls };
}

const SIGNATURE_HTML = '<p>Alex <script>alert(1)</script></p>';

describe('admin dashboard security', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function buildApp(
    options: {
      signatureStore?: SignatureStore;
      adapterFactory?: AdapterFactory;
      auditEvents?: AuditEventInput[];
      migrations?: MigrationRunner;
      statements?: ExecutedStatement[];
      mailboxWritesMatch?: boolean;
      mailboxRows?: readonly MailboxFixture[];
    } = {},
  ) {
    const app = Fastify();
    apps.push(app);
    // server.ts registers @fastify/formbody: the dashboard forms post
    // application/x-www-form-urlencoded. A flat equivalent keeps the stub light.
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );
    registerAdminDashboard(app, {
      config: { DATABASE_URL } as GatewayConfig,
      database: createDatabaseStub(options.statements, {
        ...(options.mailboxWritesMatch === undefined
          ? {}
          : { mailboxWritesMatch: options.mailboxWritesMatch }),
        ...(options.mailboxRows === undefined ? {} : { mailboxRows: options.mailboxRows }),
      }),
      audit: createAuditStub(options.auditEvents),
      adminSecret: ADMIN_SECRET,
      signatureStore: options.signatureStore ?? createSignatureStoreStub().store,
      // Never the real runner: it would open a Postgres connection.
      migrations: options.migrations ?? createMigrationRunnerStub().runner,
      ...(options.adapterFactory === undefined ? {} : { adapterFactory: options.adapterFactory }),
    });
    return app;
  }

  const authorized = { authorization: basicHeader(ADMIN_SECRET) };

  it('challenges requests without credentials', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/admin' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Basic');
  });

  it('rejects a wrong admin password', async () => {
    const response = await buildApp().inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basicHeader('wrong-password-long-enough') },
    });

    expect(response.statusCode).toBe(401);
  });

  it('renders the dashboard without delivery controls for valid credentials', async () => {
    const response = await buildApp().inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basicHeader(ADMIN_SECRET) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).not.toMatch(/<button[^>]*s[e]nd/i);
    expect(response.body).not.toMatch(/<form[^>]*action=["'][^"']*s[e]nd/i);
  });

  it('lists each sending identity once, however the stored addresses are spelled', async () => {
    const messy: MailboxFixture = {
      ...(MAILBOX_ROWS[1] as MailboxFixture),
      email_address: 'Hello@Corp.example.com',
      aliases: ['hello@corp.example.com ', 'Alex@corp.example.com', ''],
    };
    const response = await buildApp({ mailboxRows: [messy] }).inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basicHeader(ADMIN_SECRET) },
    });

    expect(response.statusCode).toBe(200);
    // The remaining-sends cell, one entry per normalized identity.
    const capacity = [...response.body.matchAll(/([a-z@.]+): \d+\/\d+/g)].map((match) => match[1]);
    expect(capacity).toEqual(['hello@corp.example.com', 'alex@corp.example.com']);
  });

  it('points every mailbox at the connect flow of its own provider', async () => {
    const response = await buildApp().inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basicHeader(ADMIN_SECRET) },
    });

    expect(response.body).toContain('/oauth/google/start?mailboxId=primary-gmail');
    expect(response.body).toContain('/oauth/microsoft/start?mailboxId=sales-outlook');
    expect(response.body).toContain('/oauth/zoho/start?mailboxId=team-zoho');
    // A provider must never be linked to another provider's connect flow: that
    // is what UNSUPPORTED_OPERATION at the far end of the redirect looks like.
    expect(response.body).not.toContain('/oauth/microsoft/start?mailboxId=team-zoho');
  });

  it('protects kill-switch mutation with admin authentication', async () => {
    const response = await buildApp().inject({
      method: 'POST',
      url: '/admin/kill-switch',
      payload: { action: 'activate' },
    });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    '/admin/signatures/sales-outlook/alex%40corp.example.com',
    '/admin/signatures/primary-gmail/sync-gmail',
    '/admin/signatures/apply-all',
  ])('protects signature mutation %s with admin authentication', async (url) => {
    const { store, upserts, deletes, applies } = createSignatureStoreStub();
    const response = await buildApp({ signatureStore: store }).inject({
      method: 'POST',
      url,
      payload: { signatureHtml: SIGNATURE_HTML },
    });

    expect(response.statusCode).toBe(401);
    expect(upserts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    expect(applies).toHaveLength(0);
  });

  it('lists every identity of enabled mailboxes and never renders stored HTML', async () => {
    const { store } = createSignatureStoreStub([
      {
        mailboxId: 'sales-outlook',
        identityEmail: 'alex@corp.example.com',
        signatureHtml: SIGNATURE_HTML,
        source: 'manual',
        updatedAt: '2026-11-02T08:00:00.000Z',
      },
    ]);
    const response = await buildApp({ signatureStore: store }).inject({
      method: 'GET',
      url: '/admin',
      headers: authorized,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<h2>Signatures</h2>');
    expect(response.body).toContain(
      'action="/admin/signatures/sales-outlook/hello%40corp.example.com"',
    );
    expect(response.body).toContain(
      'action="/admin/signatures/sales-outlook/alex%40corp.example.com"',
    );
    expect(response.body).toContain('action="/admin/signatures/primary-gmail/sync-gmail"');
    expect(response.body).not.toContain('/admin/signatures/sales-outlook/sync-gmail');
    expect(response.body).not.toContain('old%40corp.example.com');
    expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(response.body).not.toContain('<script>');
  });

  it('saves a manual signature for a mailbox identity', async () => {
    const { store, upserts } = createSignatureStoreStub();
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ signatureStore: store, auditEvents }).inject({
      method: 'POST',
      url: '/admin/signatures/sales-outlook/Alex%40Corp.example.com',
      headers: { ...authorized, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        displayName: 'Alex Morgan',
        signatureHtml: SIGNATURE_HTML,
      }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/admin');
    expect(upserts).toEqual([
      {
        mailboxId: 'sales-outlook',
        identityEmail: 'alex@corp.example.com',
        displayName: 'Alex Morgan',
        signatureHtml: SIGNATURE_HTML,
        source: 'manual',
      },
    ]);
    expect(auditEvents).toMatchObject([
      {
        operation: 'signature_update',
        mailboxId: 'sales-outlook',
        metadata: { identityEmail: 'alex@corp.example.com', action: 'upserted' },
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain('Alex <');
  });

  it('keeps a display name without a signature', async () => {
    const { store, upserts, deletes } = createSignatureStoreStub();
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ signatureStore: store, auditEvents }).inject({
      method: 'POST',
      url: '/admin/signatures/primary-gmail/outreach%40example.com',
      headers: authorized,
      payload: { displayName: ' Alex Morgan ', signatureHtml: '  ' },
    });

    expect(response.statusCode).toBe(303);
    expect(deletes).toHaveLength(0);
    // The empty signature is stored as no signature, not as blank HTML.
    expect(upserts).toEqual([
      {
        mailboxId: 'primary-gmail',
        identityEmail: 'outreach@example.com',
        displayName: 'Alex Morgan',
        signatureHtml: undefined,
        source: 'manual',
      },
    ]);
    expect(auditEvents).toMatchObject([{ metadata: { action: 'upserted' } }]);
  });

  it('deletes the stored row only when display name and signature are both empty', async () => {
    const { store, upserts, deletes } = createSignatureStoreStub();
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ signatureStore: store, auditEvents }).inject({
      method: 'POST',
      url: '/admin/signatures/primary-gmail/outreach%40example.com',
      headers: authorized,
      payload: { displayName: ' ', signatureHtml: '  ' },
    });

    expect(response.statusCode).toBe(303);
    expect(upserts).toHaveLength(0);
    expect(deletes).toEqual(['primary-gmail|outreach@example.com']);
    expect(auditEvents).toMatchObject([{ metadata: { action: 'deleted' } }]);
  });

  it('refuses an identity that is not an address of the mailbox', async () => {
    const { store, upserts } = createSignatureStoreStub();
    const response = await buildApp({ signatureStore: store }).inject({
      method: 'POST',
      url: '/admin/signatures/primary-gmail/someone%40else.com',
      headers: authorized,
      payload: { signatureHtml: SIGNATURE_HTML },
    });

    expect(response.statusCode).toBe(400);
    expect(upserts).toHaveLength(0);
  });

  it('imports the Gmail signature of every registered send-as identity', async () => {
    const { store, upserts } = createSignatureStoreStub();
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({
      signatureStore: store,
      auditEvents,
      adapterFactory: createGmailAdapterFactory([
        {
          emailAddress: 'Outreach@example.com',
          displayName: 'Alex',
          signatureHtml: SIGNATURE_HTML,
          isPrimary: true,
        },
        { emailAddress: 'unregistered@example.com', signatureHtml: '<p>x</p>', isPrimary: false },
      ]),
    }).inject({
      method: 'POST',
      url: '/admin/signatures/primary-gmail/sync-gmail',
      headers: authorized,
    });

    expect(response.statusCode).toBe(303);
    expect(upserts).toEqual([
      {
        mailboxId: 'primary-gmail',
        identityEmail: 'outreach@example.com',
        displayName: 'Alex',
        signatureHtml: SIGNATURE_HTML,
        source: 'gmail',
      },
    ]);
    expect(auditEvents).toMatchObject([
      {
        operation: 'signature_sync_gmail',
        result: 'succeeded',
        metadata: { importedIdentities: ['outreach@example.com'], ignoredIdentities: 1 },
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain('Alex <');
  });

  it('explains why a Gmail import is impossible without an adapter or for other providers', async () => {
    const withoutAdapter = await buildApp().inject({
      method: 'POST',
      url: '/admin/signatures/primary-gmail/sync-gmail',
      headers: authorized,
    });
    expect(withoutAdapter.statusCode).toBe(400);
    expect(withoutAdapter.body).toContain('Cannot import from Gmail');

    const microsoft = await buildApp({ adapterFactory: createGmailAdapterFactory([]) }).inject({
      method: 'POST',
      url: '/admin/signatures/sales-outlook/sync-gmail',
      headers: authorized,
    });
    expect(microsoft.statusCode).toBe(400);
    expect(microsoft.body).toContain('works only for Gmail mailboxes');
  });

  it('applies one signature to every other identity of the enabled mailboxes', async () => {
    const { store, upserts, applies } = createSignatureStoreStub([
      {
        mailboxId: 'primary-gmail',
        identityEmail: 'outreach@example.com',
        displayName: 'Alex',
        signatureHtml: SIGNATURE_HTML,
        source: 'gmail',
        syncedAt: '2026-11-02T07:00:00.000Z',
        updatedAt: '2026-11-02T07:00:00.000Z',
      },
    ]);
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ signatureStore: store, auditEvents }).inject({
      method: 'POST',
      url: '/admin/signatures/apply-all',
      headers: { ...authorized, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'sourceMailboxId=primary-gmail&sourceIdentityEmail=outreach%40example.com',
    });

    expect(response.statusCode).toBe(303);
    // One store call (one SQL statement) instead of an upsert per identity.
    expect(upserts).toHaveLength(0);
    expect(applies).toEqual([
      {
        sourceMailboxId: 'primary-gmail',
        sourceIdentityEmail: 'outreach@example.com',
        displayName: 'Alex',
        signatureHtml: SIGNATURE_HTML,
        signatureText: undefined,
      },
    ]);
    expect(auditEvents).toMatchObject([
      {
        operation: 'signature_apply_all',
        metadata: { updatedIdentities: OTHER_ENABLED_IDENTITIES },
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain('Alex <');
  });

  it('refuses to apply a signature that is not stored', async () => {
    const response = await buildApp().inject({
      method: 'POST',
      url: '/admin/signatures/apply-all',
      headers: authorized,
      payload: { sourceMailboxId: 'primary-gmail', sourceIdentityEmail: 'outreach@example.com' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('protects the migration apply with admin authentication', async () => {
    const { runner, runCalls } = createMigrationRunnerStub({
      pending: ['0008_mailbox_signatures.sql'],
    });
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ migrations: runner, auditEvents }).inject({
      method: 'POST',
      url: '/admin/migrations/apply',
    });

    expect(response.statusCode).toBe(401);
    expect(runCalls).toHaveLength(0);
    expect(auditEvents).toHaveLength(0);
  });

  it('lists pending migrations with an apply button', async () => {
    const { runner, listCalls } = createMigrationRunnerStub({
      pending: ['0008_mailbox_signatures.sql'],
    });
    const response = await buildApp({ migrations: runner }).inject({
      method: 'GET',
      url: '/admin',
      headers: authorized,
    });

    expect(response.statusCode).toBe(200);
    expect(listCalls).toEqual([DATABASE_URL]);
    expect(response.body).toContain('<h2>Migrations</h2>');
    expect(response.body).toContain('<code>/var/task/migrations</code>');
    expect(response.body).toContain('Applied: <strong>2</strong>');
    expect(response.body).toContain('<li><code>0008_mailbox_signatures.sql</code></li>');
    expect(response.body).toContain('action="/admin/migrations/apply"');
    expect(response.body).toContain('Apply pending migrations');
  });

  it('omits the apply button when nothing is pending', async () => {
    const response = await buildApp().inject({
      method: 'GET',
      url: '/admin',
      headers: authorized,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('No pending migrations.');
    expect(response.body).not.toContain('action="/admin/migrations/apply"');
  });

  it('applies pending migrations and audits the applied versions', async () => {
    const { runner, runCalls } = createMigrationRunnerStub({
      pending: ['0008_mailbox_signatures.sql'],
    });
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ migrations: runner, auditEvents }).inject({
      method: 'POST',
      url: '/admin/migrations/apply',
      headers: authorized,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/admin');
    expect(runCalls).toEqual([DATABASE_URL]);
    expect(auditEvents).toMatchObject([
      {
        operation: 'migrations_apply',
        result: 'succeeded',
        metadata: { applied: ['0008_mailbox_signatures.sql'] },
      },
    ]);
  });

  it('reports a failed migration run without a stack trace', async () => {
    const { runner } = createMigrationRunnerStub({
      pending: ['0008_mailbox_signatures.sql'],
      runError: new Error('relation "mailboxes" does not exist'),
    });
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ migrations: runner, auditEvents }).inject({
      method: 'POST',
      url: '/admin/migrations/apply',
      headers: authorized,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('relation "mailboxes" does not exist');
    expect(response.body).not.toMatch(/\bat .+:\d+:\d+/);
    expect(auditEvents).toMatchObject([
      {
        operation: 'migrations_apply',
        result: 'failed',
        errorCode: 'DATABASE_ERROR',
        metadata: { applied: [] },
      },
    ]);
  });

  it('still renders the dashboard when the signatures table is missing', async () => {
    const { store } = createSignatureStoreStub();
    store.listSignatures = () =>
      Promise.reject(
        Object.assign(new Error('relation "mailbox_signatures" does not exist'), {
          code: '42P01',
        }),
      );
    const response = await buildApp({ signatureStore: store }).inject({
      method: 'GET',
      url: '/admin',
      headers: authorized,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<h2>Signatures</h2>');
    expect(response.body).toContain(
      'The signatures table does not exist yet. Apply the pending migrations above.',
    );
    expect(response.body).not.toContain('action="/admin/signatures/');
  });

  it('still renders the dashboard when the migration status cannot be read', async () => {
    const { runner } = createMigrationRunnerStub({
      listError: new Error('Cannot read the migrations directory /var/task/migrations: ENOENT'),
    });
    const response = await buildApp({ migrations: runner }).inject({
      method: 'GET',
      url: '/admin',
      headers: authorized,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Cannot read the migration status');
    expect(response.body).toContain('/var/task/migrations: ENOENT');
    expect(response.body).toContain('<h2>Mailboxes</h2>');
  });

  it('renders an English page with the mailbox forms', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/admin', headers: authorized });

    expect(response.body).toContain('<html lang="en">');
    expect(response.body).toContain('<title>Yempik Mail Gateway · Admin</title>');
    expect(response.body).toContain('<h3>Add a mailbox</h3>');
    expect(response.body).toContain('action="/admin/mailboxes"');
    expect(response.body).toContain('action="/admin/mailboxes/team-zoho/update"');
    expect(response.body).toContain('name="sendLimit:alex@corp.example.com" value="15"');
  });

  it('locks provider and address only on mailboxes with an OAuth connection', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/admin', headers: authorized });
    const editorOf = (mailboxId: string) => {
      const start = response.body.indexOf(`action="/admin/mailboxes/${mailboxId}/update"`);
      return response.body.slice(start, response.body.indexOf('</form>', start));
    };

    expect(editorOf('sales-outlook')).toContain('locked because this mailbox has an OAuth');
    expect(editorOf('sales-outlook')).not.toContain('name="emailAddress"');
    expect(editorOf('sales-outlook')).not.toContain('name="provider"');
    expect(editorOf('team-zoho')).toContain('name="emailAddress"');
    expect(editorOf('team-zoho')).not.toContain('locked because');
  });

  it.each(['/admin/mailboxes', '/admin/mailboxes/team-zoho/update'])(
    'protects mailbox mutation %s with admin authentication',
    async (url) => {
      const statements: ExecutedStatement[] = [];
      const auditEvents: AuditEventInput[] = [];
      const response = await buildApp({ statements, auditEvents }).inject({
        method: 'POST',
        url,
        payload: { id: 'x-gmail', provider: 'gmail', emailAddress: 'x@example.com' },
      });

      expect(response.statusCode).toBe(401);
      expect(statements).toHaveLength(0);
      expect(auditEvents).toHaveLength(0);
    },
  );

  it('adds a mailbox at the warm-up limit and audits identifiers only', async () => {
    const statements: ExecutedStatement[] = [];
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ statements, auditEvents }).inject({
      method: 'POST',
      url: '/admin/mailboxes',
      headers: { ...authorized, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        id: 'new-outlook',
        provider: 'microsoft',
        emailAddress: ' New@Example.com ',
        aliases: 'one@example.com, Two@example.com',
        microsoftTenantId: 'contoso.onmicrosoft.com',
        displayName: '',
      }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/admin');
    const insert = statements.find((statement) => statement.sql.includes('INSERT INTO'));
    expect(insert?.sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(insert?.params).toEqual([
      'new-outlook',
      'microsoft',
      'new@example.com',
      ['one@example.com', 'two@example.com'],
      'new@example.com',
      'contoso.onmicrosoft.com',
      true,
      5,
      25,
      30,
      JSON.stringify({ 'new@example.com': 10, 'one@example.com': 10, 'two@example.com': 10 }),
      // Last in the routing order: the fixtures go up to 4.
      5,
    ]);
    expect(auditEvents).toEqual([
      {
        correlationId: expect.any(String),
        mailboxId: 'new-outlook',
        operation: 'mailbox_create',
        result: 'succeeded',
        metadata: { provider: 'microsoft', aliasCount: 2 },
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain('@');
  });

  it.each([
    [{ id: 'Bad Id', provider: 'gmail', emailAddress: 'x@example.com' }, 400, 'id:'],
    [{ id: 'x-gmail', provider: 'imap', emailAddress: 'x@example.com' }, 400, 'provider:'],
    [{ id: 'x-gmail', provider: 'gmail', emailAddress: 'not-an-address' }, 400, 'emailAddress:'],
    [
      {
        id: 'x-gmail',
        provider: 'gmail',
        emailAddress: 'x@example.com',
        microsoftTenantId: 'contoso.onmicrosoft.com',
      },
      400,
      'only valid for microsoft mailboxes',
    ],
    [{ id: 'team-zoho', provider: 'zoho', emailAddress: 'x@example.com' }, 409, 'already exists'],
    [
      {
        id: 'x-outlook',
        provider: 'microsoft',
        emailAddress: 'x@example.com',
        aliases: 'Hello@corp.example.com',
      },
      409,
      'hello@corp.example.com already belongs to mailbox sales-outlook',
    ],
  ])('refuses to add %j', async (payload, status, message) => {
    const statements: ExecutedStatement[] = [];
    const response = await buildApp({ statements }).inject({
      method: 'POST',
      url: '/admin/mailboxes',
      headers: authorized,
      payload,
    });

    expect(response.statusCode).toBe(status);
    expect(response.body).toContain(message);
    expect(statements.some((statement) => statement.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('edits aliases and limits of a connected mailbox', async () => {
    const statements: ExecutedStatement[] = [];
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ statements, auditEvents }).inject({
      method: 'POST',
      url: '/admin/mailboxes/sales-outlook/update',
      headers: { ...authorized, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        displayName: 'Example Sales',
        aliases: 'alex@corp.example.com, new@corp.example.com',
        perRunDraftLimit: '6',
        dailyDraftLimit: '30',
        'sendLimit:hello@corp.example.com': '45',
        'sendLimit:alex@corp.example.com': '15',
      }).toString(),
    });

    expect(response.statusCode).toBe(303);
    const update = statements.find((statement) => statement.sql.trim().startsWith('UPDATE'));
    // Provider, address and tenant are unchanged: no lock guard is needed.
    expect(update?.sql).not.toContain('NOT EXISTS');
    expect(update?.params).toEqual([
      'microsoft',
      'hello@corp.example.com',
      ['alex@corp.example.com', 'new@corp.example.com'],
      'Example Sales',
      null,
      6,
      30,
      45 + 15 + 10,
      JSON.stringify({
        'hello@corp.example.com': 45,
        'alex@corp.example.com': 15,
        // A new alias starts at the warm-up limit.
        'new@corp.example.com': 10,
      }),
      'sales-outlook',
    ]);
    expect(auditEvents).toMatchObject([
      {
        operation: 'mailbox_update',
        mailboxId: 'sales-outlook',
        metadata: {
          changedFields: ['aliases', 'perRunDraftLimit', 'dailyDraftLimit', 'sendLimits'],
        },
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain('@');
  });

  it('drops the limit of an alias removed in the same save', async () => {
    const statements: ExecutedStatement[] = [];
    const response = await buildApp({ statements }).inject({
      method: 'POST',
      url: '/admin/mailboxes/sales-outlook/update',
      headers: authorized,
      payload: {
        aliases: '',
        'sendLimit:hello@corp.example.com': '40',
        'sendLimit:alex@corp.example.com': '15',
      },
    });

    expect(response.statusCode).toBe(303);
    const update = statements.find((statement) => statement.sql.trim().startsWith('UPDATE'));
    expect(update?.params).toContain(JSON.stringify({ 'hello@corp.example.com': 40 }));
  });

  it.each([
    [{ emailAddress: 'someone@corp.example.com' }],
    [{ provider: 'gmail' }],
    [{ microsoftTenantId: 'contoso.onmicrosoft.com' }],
  ])('refuses to move a connected mailbox to another account: %j', async (payload) => {
    const statements: ExecutedStatement[] = [];
    const response = await buildApp({ statements }).inject({
      method: 'POST',
      url: '/admin/mailboxes/sales-outlook/update',
      headers: authorized,
      payload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('locked because this mailbox has an OAuth connection');
    expect(statements.some((statement) => statement.sql.trim().startsWith('UPDATE'))).toBe(false);
  });

  it('changes the address of a mailbox that was never connected, guarded in SQL', async () => {
    const statements: ExecutedStatement[] = [];
    const auditEvents: AuditEventInput[] = [];
    const response = await buildApp({ statements, auditEvents }).inject({
      method: 'POST',
      url: '/admin/mailboxes/team-zoho/update',
      headers: authorized,
      payload: { provider: 'zoho', emailAddress: 'team@zoho.example.com', microsoftTenantId: '' },
    });

    expect(response.statusCode).toBe(303);
    const update = statements.find((statement) => statement.sql.trim().startsWith('UPDATE'));
    expect(update?.sql).toContain('NOT EXISTS (SELECT 1 FROM "oauth_connections"');
    expect(update?.params).toContain('team@zoho.example.com');
    // The new address has no history: it warms up.
    expect(update?.params).toContain(JSON.stringify({ 'team@zoho.example.com': 10 }));
    expect(auditEvents).toMatchObject([
      { metadata: { changedFields: ['emailAddress', 'sendLimits'] } },
    ]);
  });

  it('clears the tenant pin when an unconnected Microsoft mailbox moves to another provider', async () => {
    const pinned: MailboxFixture = {
      ...(MAILBOX_ROWS[2] as MailboxFixture),
      id: 'pinned-outlook',
      provider: 'microsoft',
      email_address: 'pinned@corp.example.com',
      microsoft_tenant_id: 'contoso.onmicrosoft.com',
      daily_send_limits_by_identity: { 'pinned@corp.example.com': 25 },
    };
    const statements: ExecutedStatement[] = [];
    const auditEvents: AuditEventInput[] = [];
    // The editor always posts the tenant input, still holding the old pin.
    const response = await buildApp({
      statements,
      auditEvents,
      mailboxRows: [...MAILBOX_ROWS, pinned],
    }).inject({
      method: 'POST',
      url: '/admin/mailboxes/pinned-outlook/update',
      headers: authorized,
      payload: {
        provider: 'gmail',
        emailAddress: 'pinned@corp.example.com',
        microsoftTenantId: 'contoso.onmicrosoft.com',
      },
    });

    expect(response.statusCode).toBe(303);
    const update = statements.find((statement) => statement.sql.trim().startsWith('UPDATE'));
    // provider, email_address, aliases, display_name, microsoft_tenant_id
    expect(update?.params.slice(0, 5)).toEqual([
      'gmail',
      'pinned@corp.example.com',
      [],
      'Example Team',
      null,
    ]);
    expect(auditEvents).toMatchObject([
      { metadata: { changedFields: ['provider', 'microsoftTenantId'] } },
    ]);
  });

  it('reports a connection made while the form was open', async () => {
    const response = await buildApp({ mailboxWritesMatch: false }).inject({
      method: 'POST',
      url: '/admin/mailboxes/team-zoho/update',
      headers: authorized,
      payload: { provider: 'zoho', emailAddress: 'team@zoho.example.com' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('OAuth connection');
  });

  it.each([
    ['/admin/mailboxes/missing/update', {}, 404, 'Mailbox not found.'],
    ['/admin/mailboxes/team-zoho/update', { dailyDraftLimit: '-1' }, 400, 'dailyDraftLimit:'],
    [
      '/admin/mailboxes/team-zoho/update',
      { 'sendLimit:outreach@zoho.example.com': '2.5' },
      400,
      'sendLimits.outreach@zoho.example.com:',
    ],
  ])('refuses the update %s %j', async (url, payload, status, message) => {
    const statements: ExecutedStatement[] = [];
    const response = await buildApp({ statements }).inject({
      method: 'POST',
      url,
      headers: authorized,
      payload,
    });

    expect(response.statusCode).toBe(status);
    expect(response.body).toContain(message);
    expect(statements.some((statement) => statement.sql.trim().startsWith('UPDATE'))).toBe(false);
  });
});
