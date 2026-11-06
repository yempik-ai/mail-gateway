import { describe, expect, it } from 'vitest';
import type { SQL } from '../../apps/mcp-server/node_modules/drizzle-orm/index.js';
import { PgDialect } from '../../apps/mcp-server/node_modules/drizzle-orm/pg-core/index.js';
import type { Database } from '../../packages/database/src/index.js';
import {
  createDatabaseSignatureStore,
  normalizeIdentityEmail,
} from '../../apps/mcp-server/src/signature-store.js';

interface RenderedQuery {
  sql: string;
  params: unknown[];
}

// Postgres is not available to unit tests: render every statement the store
// issues with the real dialect and answer it with canned rows.
function createDatabaseStub(rows: Record<string, unknown>[] = [], rowCount = rows.length) {
  const dialect = new PgDialect();
  const queries: RenderedQuery[] = [];
  const database = {
    execute(query: SQL) {
      const rendered = dialect.sqlToQuery(query);
      queries.push({ sql: rendered.sql.replace(/\s+/g, ' ').trim(), params: rendered.params });
      return Promise.resolve({ rows, rowCount });
    },
  } as unknown as Database;
  return { database, queries };
}

const ROW = {
  mailbox_id: 'sales-outlook',
  identity_email: 'alex@corp.example.com',
  display_name: 'Alex Morgan',
  signature_html: '<p>Alex</p>',
  signature_text: null,
  source: 'manual',
  synced_at: null,
  updated_at: new Date('2026-11-02T08:00:00.000Z'),
};

describe('signature store', () => {
  it('normalizes identity emails and refuses empty ones', () => {
    expect(normalizeIdentityEmail('  Alex@Corp.example.COM ')).toBe('alex@corp.example.com');
    expect(() => normalizeIdentityEmail('   ')).toThrow(TypeError);
  });

  it('looks a signature up by the normalized identity and maps the row', async () => {
    const { database, queries } = createDatabaseStub([ROW]);
    const store = createDatabaseSignatureStore(database);

    const signature = await store.getSignature('sales-outlook', ' ALEX@corp.example.com');

    expect(queries[0]?.sql).toContain('FROM "mailbox_signatures"');
    expect(queries[0]?.params).toEqual(['sales-outlook', 'alex@corp.example.com']);
    // Absent columns are absent properties, never `undefined` or `null`.
    expect(signature).toStrictEqual({
      mailboxId: 'sales-outlook',
      identityEmail: 'alex@corp.example.com',
      displayName: 'Alex Morgan',
      signatureHtml: '<p>Alex</p>',
      source: 'manual',
      updatedAt: '2026-11-02T08:00:00.000Z',
    });
  });

  it('returns undefined when no row exists', async () => {
    const { database } = createDatabaseStub([]);
    await expect(
      createDatabaseSignatureStore(database).getSignature('primary-gmail', 'outreach@example.com'),
    ).resolves.toBeUndefined();
  });

  it('upserts manual HTML without a text part and without a sync timestamp', async () => {
    const { database, queries } = createDatabaseStub([ROW]);

    await createDatabaseSignatureStore(database).upsertSignature({
      mailboxId: 'sales-outlook',
      identityEmail: 'Alex@Corp.example.com ',
      displayName: '  Alex Morgan ',
      signatureHtml: '<p>Alex</p>\n',
      source: 'manual',
    });

    const query = queries[0];
    expect(query?.sql).toContain('INSERT INTO "mailbox_signatures"');
    expect(query?.sql).toContain('ON CONFLICT (mailbox_id, identity_email) DO UPDATE');
    expect(query?.sql).toContain('NULL )');
    expect(query?.params).toEqual([
      'sales-outlook',
      'alex@corp.example.com',
      'Alex Morgan',
      '<p>Alex</p>',
      null,
      'manual',
    ]);
  });

  it('stamps synced_at for Gmail imports and stores blank content as NULL', async () => {
    const { database, queries } = createDatabaseStub([{ ...ROW, source: 'gmail' }]);

    await createDatabaseSignatureStore(database).upsertSignature({
      mailboxId: 'primary-gmail',
      identityEmail: 'outreach@example.com',
      signatureHtml: '   ',
      source: 'gmail',
    });

    expect(queries[0]?.sql).toContain('now() )');
    expect(queries[0]?.params).toEqual([
      'primary-gmail',
      'outreach@example.com',
      null,
      null,
      null,
      'gmail',
    ]);
  });

  it('deletes by the normalized identity', async () => {
    const { database, queries } = createDatabaseStub();
    await createDatabaseSignatureStore(database).deleteSignature('m', 'A@B.it');
    expect(queries[0]?.sql).toContain('DELETE FROM "mailbox_signatures"');
    expect(queries[0]?.params).toEqual(['m', 'a@b.it']);
  });

  it('applies one signature to every other enabled identity in a single statement', async () => {
    const { database, queries } = createDatabaseStub([], 3);

    const result = await createDatabaseSignatureStore(database).applySignatureToAllIdentities({
      sourceMailboxId: 'primary-gmail',
      sourceIdentityEmail: ' Outreach@Example.com',
      displayName: ' Alex ',
      signatureHtml: '<p>Alex</p>',
    });

    expect(result).toEqual({ updatedIdentities: 3 });
    // One statement is one transaction: no identity can end up half-applied.
    expect(queries).toHaveLength(1);
    const query = queries[0];
    expect(query?.sql).toContain('INSERT INTO "mailbox_signatures"');
    expect(query?.sql).toContain('FROM "mailboxes" m');
    expect(query?.sql).toContain(
      'CROSS JOIN LATERAL unnest(array_append(m.aliases, m.email_address)) AS i(email)',
    );
    expect(query?.sql).toContain('WHERE m.enabled');
    expect(query?.sql).toContain('ON CONFLICT (mailbox_id, identity_email) DO UPDATE SET');
    expect(query?.sql).toContain("source = 'manual'");
    expect(query?.sql).toContain('synced_at = NULL');
    expect(query?.params).toEqual([
      'Alex',
      '<p>Alex</p>',
      null,
      'primary-gmail',
      'outreach@example.com',
    ]);
  });
});
