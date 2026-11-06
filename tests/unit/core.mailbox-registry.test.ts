import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  changedAccountFields,
  formatRegistryIssues,
  lockedAccountChanges,
  mailboxAddressConflict,
  mailboxRegistryEntrySchema,
  mailboxRegistrySchema,
  resolveMailboxRecord,
  WARM_UP_DAILY_SEND_LIMIT,
  type StoredMailboxSettings,
} from '../../packages/core/src/index.js';

const EXAMPLE_FILE = new URL('../../mailboxes.example.json', import.meta.url);

const STORED: StoredMailboxSettings = {
  emailAddress: 'hello@example.com',
  aliases: ['sales@example.com'],
  displayName: 'Example Sales',
  microsoftTenantId: 'contoso.onmicrosoft.com',
  routingPriority: 3,
  perRunDraftLimit: 4,
  dailyDraftLimit: 30,
  dailySendLimit: 55,
  dailySendLimitsByIdentity: { 'hello@example.com': 40, 'sales@example.com': 15 },
  enabled: false,
};

function issuesOf(input: unknown): string {
  const parsed = mailboxRegistrySchema.safeParse(input);
  if (parsed.success) throw new Error('expected the registry to be rejected');
  return formatRegistryIssues(parsed.error);
}

describe('mailbox registry schema', () => {
  it('accepts the committed example file', () => {
    const registry = mailboxRegistrySchema.parse(JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8')));
    expect(registry.mailboxes.map((mailbox) => mailbox.provider)).toEqual([
      'gmail',
      'microsoft',
      'zoho',
    ]);
    // Adopters copy this file: it must never carry a real domain.
    for (const mailbox of registry.mailboxes) {
      for (const address of [mailbox.emailAddress, ...mailbox.aliases]) {
        expect(address).toMatch(/@example\.com$/);
      }
    }
  });

  it('normalizes addresses and send-limit keys to lowercase', () => {
    const entry = mailboxRegistryEntrySchema.parse({
      id: 'sales-outlook',
      provider: 'microsoft',
      emailAddress: ' Hello@Example.com ',
      aliases: ['Sales@Example.com'],
      sendLimits: { 'SALES@example.com': 5 },
    });
    expect(entry.emailAddress).toBe('hello@example.com');
    expect(entry.aliases).toEqual(['sales@example.com']);
    expect(entry.sendLimits).toEqual({ 'sales@example.com': 5 });
  });

  it('rejects unsafe ids, unknown providers and unknown fields', () => {
    const issues = issuesOf({
      mailboxes: [
        { id: 'Has Spaces', provider: 'gmail', emailAddress: 'a@example.com' },
        { id: 'ok-id', provider: 'imap', emailAddress: 'b@example.com' },
        { id: 'ok-id-2', provider: 'gmail', emailAddress: 'c@example.com', tenant: 'x' },
      ],
    });
    expect(issues).toContain('mailboxes.0.id');
    expect(issues).toContain('mailboxes.1.provider');
    expect(issues).toContain('mailboxes.2');
  });

  it('rejects a tenant pin outside Microsoft and the multi-tenant endpoints', () => {
    expect(
      issuesOf({
        mailboxes: [
          {
            id: 'a-gmail',
            provider: 'gmail',
            emailAddress: 'a@example.com',
            microsoftTenantId: 'contoso.onmicrosoft.com',
          },
          {
            id: 'b-outlook',
            provider: 'microsoft',
            emailAddress: 'b@example.com',
            microsoftTenantId: 'common',
          },
        ],
      }),
    ).toMatch(/mailboxes\.0\.microsoftTenantId[\s\S]*mailboxes\.1\.microsoftTenantId/);
  });

  it('rejects send limits for addresses the mailbox does not own', () => {
    expect(
      issuesOf({
        mailboxes: [
          {
            id: 'a-gmail',
            provider: 'gmail',
            emailAddress: 'a@example.com',
            sendLimits: { 'someone@example.com': 5 },
          },
        ],
      }),
    ).toContain('someone@example.com is neither the primary address nor an alias');
  });

  it('rejects duplicate ids and an address shared by two mailboxes', () => {
    const issues = issuesOf({
      mailboxes: [
        { id: 'a', provider: 'gmail', emailAddress: 'a@example.com' },
        { id: 'a', provider: 'gmail', emailAddress: 'b@example.com' },
        { id: 'c', provider: 'zoho', emailAddress: 'c@example.com', aliases: ['A@example.com'] },
        { id: 'd', provider: 'zoho', emailAddress: 'd@example.com', aliases: ['d@example.com'] },
      ],
    });
    expect(issues).toContain('mailbox id a is used twice');
    expect(issues).toContain('a@example.com belongs to both a and c');
    expect(issues).toContain('mailboxes.3.aliases.0');
  });
});

describe('resolveMailboxRecord', () => {
  it('starts a new mailbox at the warm-up limit for every identity', () => {
    const entry = mailboxRegistryEntrySchema.parse({
      id: 'sales-outlook',
      provider: 'microsoft',
      emailAddress: 'hello@example.com',
      aliases: ['sales@example.com'],
    });
    expect(resolveMailboxRecord(entry, undefined, 7)).toEqual({
      id: 'sales-outlook',
      provider: 'microsoft',
      emailAddress: 'hello@example.com',
      aliases: ['sales@example.com'],
      displayName: 'hello@example.com',
      microsoftTenantId: null,
      routingPriority: 7,
      perRunDraftLimit: 5,
      dailyDraftLimit: 25,
      dailySendLimit: 2 * WARM_UP_DAILY_SEND_LIMIT,
      dailySendLimitsByIdentity: {
        'hello@example.com': WARM_UP_DAILY_SEND_LIMIT,
        'sales@example.com': WARM_UP_DAILY_SEND_LIMIT,
      },
      enabled: true,
    });
  });

  it('keeps stored values for omitted fields and sums identity limits', () => {
    const entry = mailboxRegistryEntrySchema.parse({
      id: 'sales-outlook',
      provider: 'microsoft',
      emailAddress: 'hello@example.com',
      aliases: ['sales@example.com', 'new@example.com'],
      sendLimits: { 'sales@example.com': 20 },
    });
    const record = resolveMailboxRecord(entry, STORED, 1);
    expect(record).toMatchObject({
      displayName: 'Example Sales',
      microsoftTenantId: 'contoso.onmicrosoft.com',
      routingPriority: 3,
      perRunDraftLimit: 4,
      dailyDraftLimit: 30,
      enabled: false,
      dailySendLimitsByIdentity: {
        'hello@example.com': 40,
        'sales@example.com': 20,
        // A new alias has no history: it warms up like a new mailbox.
        'new@example.com': WARM_UP_DAILY_SEND_LIMIT,
      },
      dailySendLimit: 40 + 20 + WARM_UP_DAILY_SEND_LIMIT,
    });
  });

  it('keeps the effective limit of a stored identity that had no entry of its own', () => {
    const entry = mailboxRegistryEntrySchema.parse({
      id: 'sales-outlook',
      provider: 'microsoft',
      emailAddress: 'hello@example.com',
    });
    const record = resolveMailboxRecord(
      entry,
      { ...STORED, aliases: [], dailySendLimit: 25, dailySendLimitsByIdentity: {} },
      1,
    );
    // The send path falls back to the aggregate for such an identity.
    expect(record.dailySendLimitsByIdentity).toEqual({ 'hello@example.com': 25 });
  });

  it('clears a tenant pin only when asked to with null', () => {
    const base = { id: 'sales-outlook', provider: 'microsoft', emailAddress: 'hello@example.com' };
    expect(
      resolveMailboxRecord(
        mailboxRegistryEntrySchema.parse({ ...base, microsoftTenantId: null }),
        STORED,
        1,
      ).microsoftTenantId,
    ).toBeNull();
    expect(
      resolveMailboxRecord(mailboxRegistryEntrySchema.parse(base), STORED, 1).microsoftTenantId,
    ).toBe('contoso.onmicrosoft.com');
  });

  it('drops a stored tenant pin when the mailbox leaves Microsoft', () => {
    const entry = mailboxRegistryEntrySchema.parse({
      id: 'sales-outlook',
      provider: 'gmail',
      emailAddress: 'hello@example.com',
    });
    expect(resolveMailboxRecord(entry, STORED, 1).microsoftTenantId).toBeNull();
  });
});

describe('mailbox account lock and address ownership', () => {
  const account = {
    provider: 'microsoft' as const,
    emailAddress: 'Hello@Example.com',
    microsoftTenantId: 'contoso.onmicrosoft.com',
  };

  it('lists the account fields a write changes, comparing addresses case-insensitively', () => {
    expect(
      changedAccountFields({ ...account, emailAddress: 'hello@example.com' }, account),
    ).toEqual([]);
    expect(
      changedAccountFields(
        { provider: 'gmail', emailAddress: 'x@example.com', microsoftTenantId: null },
        account,
      ),
    ).toEqual(['provider', 'emailAddress', 'microsoftTenantId']);
    // A leftover pin outside Microsoft is not an account.
    expect(
      changedAccountFields(
        { provider: 'gmail', emailAddress: 'x@example.com', microsoftTenantId: null },
        {
          provider: 'gmail',
          emailAddress: 'x@example.com',
          microsoftTenantId: 'stale.example.com',
        },
      ),
    ).toEqual([]);
  });

  it('locks those fields only on a mailbox with an OAuth connection', () => {
    const moved = { ...account, microsoftTenantId: 'fabrikam.onmicrosoft.com' };
    expect(lockedAccountChanges(moved, account, true)).toEqual(['microsoftTenantId']);
    expect(lockedAccountChanges(moved, account, false)).toEqual([]);
  });

  it('names the first identity another mailbox already owns', () => {
    const others = [
      { id: 'a', emailAddress: 'a@example.com', aliases: ['shared@example.com'] },
      { id: 'self', emailAddress: 'mine@example.com', aliases: [] },
    ];
    expect(
      mailboxAddressConflict(
        { id: 'self', emailAddress: 'mine@example.com', aliases: [' Shared@Example.com'] },
        others,
      ),
    ).toBe('shared@example.com already belongs to mailbox a.');
    expect(
      mailboxAddressConflict({ id: 'self', emailAddress: 'MINE@example.com', aliases: [] }, others),
    ).toBeUndefined();
  });
});
