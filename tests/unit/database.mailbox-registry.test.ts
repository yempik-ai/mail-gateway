import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mailboxRegistrySchema } from '../../packages/core/src/index.js';
import {
  assertMailboxSeedAllowed,
  planMailboxSeed,
  readMailboxRegistry,
  type ExistingMailbox,
} from '../../packages/database/src/mailbox-registry-file.js';

const EXAMPLE_FILE = fileURLToPath(new URL('../../mailboxes.example.json', import.meta.url));

function tempFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mailbox-registry-')), name);
  writeFileSync(path, contents);
  return path;
}

describe('mailbox registry file', () => {
  it('plans the example file with explicit limits and file-order priorities', async () => {
    const registry = await readMailboxRegistry(EXAMPLE_FILE);
    if (!registry) throw new Error('the example registry must exist');
    const plan = planMailboxSeed(registry, new Map());
    expect(plan.map((mailbox) => [mailbox.id, mailbox.routingPriority])).toEqual([
      ['outreach-gmail', 1],
      ['sales-outlook', 2],
      ['team-zoho', 3],
    ]);
    expect(plan[1]).toMatchObject({
      aliases: ['sales@example.com'],
      microsoftTenantId: '00000000-0000-0000-0000-000000000000',
      dailySendLimit: 15,
      dailySendLimitsByIdentity: { 'hello@example.com': 10, 'sales@example.com': 5 },
    });
    expect(plan[2]).toMatchObject({ enabled: false, displayName: 'team@example.com' });
  });

  it('treats a missing default file as "no mailboxes" but a missing explicit file as an error', async () => {
    const missing = join(tmpdir(), 'mailbox-registry-does-not-exist.json');
    await expect(readMailboxRegistry(missing, { optional: true })).resolves.toBeUndefined();
    await expect(readMailboxRegistry(missing)).rejects.toThrow(
      `Cannot read the mailbox registry ${missing}`,
    );
  });

  it('reports every validation problem with its path', async () => {
    const path = tempFile(
      'mailboxes.json',
      JSON.stringify({ mailboxes: [{ id: 'x', provider: 'gmail', emailAddress: 'nope' }] }),
    );
    await expect(readMailboxRegistry(path)).rejects.toThrow(/mailboxes\.0\.emailAddress/);
  });

  it('rejects a file that is not JSON', async () => {
    const path = tempFile('mailboxes.json', '{ mailboxes: [] ');
    await expect(readMailboxRegistry(path)).rejects.toThrow('is not valid JSON');
  });
});

describe('seed checks against the database', () => {
  const stored = (overrides: Partial<ExistingMailbox> & { id: string }): ExistingMailbox => ({
    provider: 'gmail',
    emailAddress: `${overrides.id}@example.com`,
    aliases: [],
    displayName: overrides.id,
    microsoftTenantId: null,
    routingPriority: 1,
    perRunDraftLimit: 5,
    dailyDraftLimit: 25,
    dailySendLimit: 10,
    dailySendLimitsByIdentity: {},
    enabled: true,
    hasOAuthConnection: false,
    ...overrides,
  });
  const plan = (mailboxes: unknown[], existing: ExistingMailbox[]) =>
    planMailboxSeed(
      mailboxRegistrySchema.parse({ mailboxes }),
      new Map(existing.map((row) => [row.id, row])),
    );

  it('refuses to change the account of a connected mailbox, naming it and the fields', () => {
    const connected = stored({
      id: 'sales',
      provider: 'microsoft',
      emailAddress: 'Hello@Example.com',
      microsoftTenantId: 'contoso.onmicrosoft.com',
      hasOAuthConnection: true,
    });
    const moved = plan(
      [{ id: 'sales', provider: 'microsoft', emailAddress: 'other@example.com' }],
      [connected],
    );
    expect(() => assertMailboxSeedAllowed(moved, [connected])).toThrow(
      /nothing was written:\nmailbox sales: the file changes emailAddress\. Provider, primary address and Microsoft tenant are locked/,
    );
    const switched = plan(
      [{ id: 'sales', provider: 'gmail', emailAddress: 'hello@example.com' }],
      [connected],
    );
    expect(() => assertMailboxSeedAllowed(switched, [connected])).toThrow(
      'mailbox sales: the file changes provider, microsoftTenantId.',
    );
    // The same account in another spelling, with new aliases and limits.
    const tuned = plan(
      [
        {
          id: 'sales',
          provider: 'microsoft',
          emailAddress: 'hello@example.com',
          aliases: ['team@example.com'],
          dailyDraftLimit: 40,
        },
      ],
      [connected],
    );
    expect(() => assertMailboxSeedAllowed(tuned, [connected])).not.toThrow();
    // The same move on a mailbox that was never connected.
    const unconnected = { ...connected, hasOAuthConnection: false };
    expect(() => assertMailboxSeedAllowed(moved, [unconnected])).not.toThrow();
  });

  it('refuses an address another mailbox in the database owns', () => {
    const existing = [stored({ id: 'legacy', aliases: ['shared@example.com'] })];
    const claimed = plan(
      [
        {
          id: 'new-one',
          provider: 'zoho',
          emailAddress: 'x@example.com',
          aliases: ['SHARED@example.com'],
        },
      ],
      existing,
    );
    expect(() => assertMailboxSeedAllowed(claimed, existing)).toThrow(
      'mailbox new-one: shared@example.com already belongs to mailbox legacy.',
    );
    // Once the file also lists `legacy` without the alias, the alias moves.
    const moved = plan(
      [
        { id: 'legacy', provider: 'gmail', emailAddress: 'legacy@example.com' },
        {
          id: 'new-one',
          provider: 'zoho',
          emailAddress: 'x@example.com',
          aliases: ['shared@example.com'],
        },
      ],
      existing,
    );
    expect(() => assertMailboxSeedAllowed(moved, existing)).not.toThrow();
  });

  it('reports every problem at once', () => {
    const existing = [
      stored({ id: 'locked', hasOAuthConnection: true }),
      stored({ id: 'owner', emailAddress: 'taken@example.com' }),
    ];
    const both = plan(
      [
        { id: 'locked', provider: 'zoho', emailAddress: 'locked@example.com' },
        { id: 'fresh', provider: 'gmail', emailAddress: 'taken@example.com' },
      ],
      existing,
    );
    expect(() => assertMailboxSeedAllowed(both, existing)).toThrow(
      /mailbox locked: the file changes provider\.[^\n]*\nmailbox fresh: taken@example\.com already belongs to mailbox owner\./,
    );
  });
});
