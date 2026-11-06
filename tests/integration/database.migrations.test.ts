// Applies the real migrations to a real PostgreSQL and exercises the
// signature store against the resulting schema. It runs only when
// DATABASE_URL is set in the environment and reachable (CI starts a postgres
// service); otherwise it is skipped, so `pnpm -r test` needs no database.
// Under CI=true a DATABASE_URL that cannot be reached fails instead.
//
// The URL is read before anything imports @yempik/database, whose migrate
// module loads the repo-root .env: a developer's .env pointing at a Neon
// branch must not turn a local test run into a migration against it. Even
// when the test does run, it works in a throwaway schema it drops at the end.
// Use a direct connection: a transaction pooler ignores the search_path
// startup option the isolation relies on.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Type-only: erased at runtime, so neither module loads before DATABASE_URL is read.
import type * as DatabaseModuleNamespace from '../../packages/database/src/index.js';
import type * as SignatureStoreModuleNamespace from '../../apps/mcp-server/src/signature-store.js';

const databaseUrl = process.env.DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

type DatabaseModule = typeof DatabaseModuleNamespace;
type SignatureStoreModule = typeof SignatureStoreModuleNamespace;

async function unavailableReason(): Promise<string | undefined> {
  if (!databaseUrl) return 'DATABASE_URL is not set';
  const { createDatabase } = await import('../../packages/database/src/index.js');
  const { pool } = createDatabase(databaseUrl, { max: 1, connectionTimeoutMillis: 3_000 });
  try {
    await pool.query('SELECT 1');
    return undefined;
  } catch (error) {
    return `DATABASE_URL is not reachable (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    await pool.end();
  }
}

const skipReason = await unavailableReason();
// CI provides the database on purpose: losing it must fail the build, not
// quietly skip the only test that runs the migrations.
if (skipReason !== undefined && databaseUrl && process.env.CI === 'true') {
  throw new Error(`[database.migrations] ${skipReason}`);
}
if (skipReason !== undefined) {
  // Straight to stderr: the reporter drops console output of a skipped file.
  process.stderr.write(`[database.migrations] skipped: ${skipReason}\n`);
}

/** Same database, every unqualified name resolved in `schema` only. */
function urlForSchema(url: string, schema: string): string {
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  return scoped.toString();
}

describe.skipIf(skipReason !== undefined)('database migrations on PostgreSQL', () => {
  const schema = `gateway_test_${randomBytes(6).toString('hex')}`;
  let database: DatabaseModule;
  let signatures: SignatureStoreModule;
  let schemaUrl: string;
  let admin: ReturnType<DatabaseModule['createDatabase']>;
  let scoped: ReturnType<DatabaseModule['createDatabase']>;
  let migrationFiles: string[];

  beforeAll(async () => {
    database = await import('../../packages/database/src/index.js');
    signatures = await import('../../apps/mcp-server/src/signature-store.js');
    admin = database.createDatabase(databaseUrl ?? '', { max: 1 });
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    schemaUrl = urlForSchema(databaseUrl ?? '', schema);
    scoped = database.createDatabase(schemaUrl, { max: 2 });
    migrationFiles = (await readdir(MIGRATIONS_DIRECTORY))
      .filter((file) => /^\d+.*\.sql$/u.test(file))
      .sort();
  });

  afterAll(async () => {
    await scoped?.pool.end();
    await admin?.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.pool.end();
  });

  it('applies every migration to a fresh schema and records it', async () => {
    const run = await database.runMigrations(schemaUrl, MIGRATIONS_DIRECTORY);
    expect(run.applied).toEqual(migrationFiles);

    const recorded = await scoped.pool.query<{ version: string }>(
      'SELECT version FROM gateway_schema_migrations ORDER BY version',
    );
    expect(recorded.rows.map((row) => row.version)).toEqual(migrationFiles);

    const tables = await scoped.pool.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
      [schema],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['mailboxes', 'drafts', 'audit_events', 'mailbox_signatures']),
    );
  });

  it('re-runs as a no-op with nothing pending', async () => {
    const rerun = await database.runMigrations(schemaUrl, MIGRATIONS_DIRECTORY);
    expect(rerun.applied).toEqual([]);
    const status = await database.listPendingMigrations(schemaUrl, MIGRATIONS_DIRECTORY);
    expect(status.pending).toEqual([]);
    expect(status.applied).toEqual(migrationFiles);
  });

  it('stores, reads and fans out signatures against the real schema', async () => {
    const insertMailbox = (
      id: string,
      provider: string,
      email: string,
      aliases: string[],
      enabled: boolean,
      priority: number,
    ) =>
      scoped.pool.query(
        `INSERT INTO mailboxes (id, provider, email_address, display_name, aliases, enabled, routing_priority)
         VALUES ($1, $2, $3, $1, $4, $5, $6)`,
        [id, provider, email, aliases, enabled, priority],
      );
    await insertMailbox('gmail-main', 'gmail', 'outreach@example.com', [], true, 1);
    await insertMailbox(
      'outlook-main',
      'microsoft',
      'hello@example.org',
      ['Sales@Example.org ', 'sales@example.org', ''],
      true,
      2,
    );
    await insertMailbox('zoho-off', 'zoho', 'off@example.net', [], false, 3);

    const store = signatures.createDatabaseSignatureStore(scoped.db);
    const saved = await store.upsertSignature({
      mailboxId: 'gmail-main',
      identityEmail: ' Outreach@Example.com ',
      displayName: 'Alex',
      signatureHtml: '<p>Alex<br>Example Ltd</p>',
      source: 'gmail',
    });
    expect(saved).toMatchObject({
      mailboxId: 'gmail-main',
      identityEmail: 'outreach@example.com',
      displayName: 'Alex',
      signatureHtml: '<p>Alex<br>Example Ltd</p>',
      source: 'gmail',
    });
    expect(saved.syncedAt).toBeDefined();

    expect(await store.getSignature('gmail-main', 'OUTREACH@example.com')).toEqual(saved);
    expect(await store.getSignature('gmail-main', 'missing@example.com')).toBeUndefined();

    // A manual edit of an imported row clears the sync marker.
    const edited = await store.upsertSignature({
      mailboxId: 'gmail-main',
      identityEmail: 'outreach@example.com',
      signatureHtml: '<p>Edited</p>',
      source: 'manual',
    });
    expect(edited).toMatchObject({ source: 'manual', signatureHtml: '<p>Edited</p>' });
    expect(edited.syncedAt).toBeUndefined();
    expect(edited.displayName).toBeUndefined();

    const { updatedIdentities } = await store.applySignatureToAllIdentities({
      sourceMailboxId: 'gmail-main',
      sourceIdentityEmail: 'outreach@example.com',
      displayName: 'Team',
      signatureHtml: '<p>Shared</p>',
    });
    // hello@ plus the de-duplicated alias; the disabled mailbox and the source are skipped.
    expect(updatedIdentities).toBe(2);
    const all = await store.listSignatures();
    expect(all.map((row) => `${row.mailboxId}/${row.identityEmail}`)).toEqual([
      'gmail-main/outreach@example.com',
      'outlook-main/hello@example.org',
      'outlook-main/sales@example.org',
    ]);
    for (const row of all.filter((entry) => entry.mailboxId === 'outlook-main')) {
      expect(row).toMatchObject({
        displayName: 'Team',
        signatureHtml: '<p>Shared</p>',
        source: 'manual',
      });
    }

    await store.deleteSignature('outlook-main', 'sales@example.org');
    expect(await store.getSignature('outlook-main', 'sales@example.org')).toBeUndefined();
  });

  it('seeds a registry whole, or refuses it before writing anything', async () => {
    const { seedDatabase } = await import('../../packages/database/src/seed.js');
    const directory = mkdtempSync(join(tmpdir(), 'seed-integration-'));
    const seed = (mailboxes: unknown[]) => {
      const path = join(directory, `mailboxes-${randomBytes(4).toString('hex')}.json`);
      writeFileSync(path, JSON.stringify({ mailboxes }));
      return seedDatabase({ DATABASE_URL: schemaUrl, MAILBOXES_FILE: path });
    };
    const mailboxIds = async () =>
      (
        await scoped.pool.query<{ id: string }>(
          `SELECT id FROM mailboxes WHERE id LIKE 'seed-%' ORDER BY id`,
        )
      ).rows.map((row) => row.id);

    await scoped.pool.query(
      `INSERT INTO mailboxes (id, provider, email_address, display_name, microsoft_tenant_id, routing_priority)
       VALUES ('seed-connected', 'microsoft', 'hello@seed.example.test', 'Connected', 'contoso.onmicrosoft.com', 10),
              ('seed-other', 'gmail', 'other@seed.example.test', 'Other', NULL, 11)`,
    );
    await scoped.pool.query(
      `INSERT INTO oauth_connections (mailbox_id, provider, status) VALUES ('seed-connected', 'microsoft', 'connected')`,
    );
    const connected = {
      id: 'seed-connected',
      provider: 'microsoft',
      emailAddress: 'hello@seed.example.test',
    };
    const fresh = { id: 'seed-new', provider: 'gmail', emailAddress: 'new@seed.example.test' };

    // The dashboard's lock: provider, address and tenant of a connected mailbox.
    // Leaving Microsoft also drops the tenant pin, so both are named.
    for (const [change, fields] of [
      [{ provider: 'gmail' }, 'provider, microsoftTenantId'],
      [{ emailAddress: 'moved@seed.example.test' }, 'emailAddress'],
      [{ microsoftTenantId: 'fabrikam.onmicrosoft.com' }, 'microsoftTenantId'],
    ] as const) {
      await expect(seed([fresh, { ...connected, ...change }])).rejects.toThrow(
        `mailbox seed-connected: the file changes ${fields}. Provider, primary address and Microsoft tenant are locked`,
      );
    }
    // An address owned by a mailbox the file does not list.
    await expect(seed([{ ...fresh, aliases: ['Other@seed.example.test'] }])).rejects.toThrow(
      'mailbox seed-new: other@seed.example.test already belongs to mailbox seed-other.',
    );
    // Nothing was written by any refused seed.
    expect(await mailboxIds()).toEqual(['seed-connected', 'seed-other']);
    const untouched = await scoped.pool.query(
      `SELECT provider, email_address, microsoft_tenant_id FROM mailboxes WHERE id = 'seed-connected'`,
    );
    expect(untouched.rows[0]).toEqual({
      provider: 'microsoft',
      email_address: 'hello@seed.example.test',
      microsoft_tenant_id: 'contoso.onmicrosoft.com',
    });

    // Unlocked fields of a connected mailbox, and an alias that moves between
    // two mailboxes the file lists, are fine.
    await seed([
      { ...connected, displayName: 'Renamed', aliases: ['sales@seed.example.test'] },
      { ...fresh, aliases: ['other@seed.example.test'] },
      { id: 'seed-other', provider: 'gmail', emailAddress: 'other2@seed.example.test' },
    ]);
    const seeded = await scoped.pool.query(
      `SELECT id, display_name, aliases, microsoft_tenant_id FROM mailboxes WHERE id LIKE 'seed-%' ORDER BY id`,
    );
    expect(seeded.rows).toEqual([
      {
        id: 'seed-connected',
        display_name: 'Renamed',
        aliases: ['sales@seed.example.test'],
        microsoft_tenant_id: 'contoso.onmicrosoft.com',
      },
      {
        id: 'seed-new',
        display_name: 'new@seed.example.test',
        aliases: ['other@seed.example.test'],
        microsoft_tenant_id: null,
      },
      { id: 'seed-other', display_name: 'Other', aliases: [], microsoft_tenant_id: null },
    ]);
  });

  it('lets an MCP OAuth code be consumed once, even by concurrent exchanges', async () => {
    const mcpOAuth = await import('../../apps/mcp-server/src/mcp-oauth.js');
    const store = mcpOAuth.createDrizzleMcpOAuthStore(scoped.db, 'test');
    const client = { id: 'dcr-integration', displayName: 'Integration', secretHash: 'unused' };
    await store.registerClient(client);
    expect(await store.findActiveClient(client.id)).toEqual(client);
    // Clients are scoped to the environment they registered in.
    expect(
      await mcpOAuth
        .createDrizzleMcpOAuthStore(scoped.db, 'production')
        .findActiveClient(client.id),
    ).toBeUndefined();

    const now = new Date();
    await store.insertGrants([
      {
        mcpClientId: client.id,
        kind: 'code',
        tokenHash: 'code-hash',
        codeChallenge: 'challenge',
        redirectUri: 'https://claude.ai/api/mcp/auth_callback',
        expiresAt: new Date(now.getTime() + 60_000),
      },
    ]);
    const grant = await store.findUsableGrant('code-hash', 'code', now);
    expect(grant).toMatchObject({
      mcpClientId: client.id,
      codeChallenge: 'challenge',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    });
    expect(await store.findUsableGrant('code-hash', 'refresh', now)).toBeUndefined();

    const outcomes = await Promise.all([
      store.consumeGrant(grant?.id ?? '', now),
      store.consumeGrant(grant?.id ?? '', now),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await store.findUsableGrant('code-hash', 'code', now)).toBeUndefined();
  });
});
