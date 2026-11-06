import { z } from 'zod';
import { MAILBOX_PROVIDERS, type MailboxProvider } from './types.js';

/**
 * Daily sends granted to a sending identity that has no explicit limit. A new
 * domain or mailbox that sends at full volume on day one is the classic spam
 * signal, so every identity starts low and the operator raises it on purpose.
 */
export const WARM_UP_DAILY_SEND_LIMIT = 10;
export const DEFAULT_PER_RUN_DRAFT_LIMIT = 5;
export const DEFAULT_DAILY_DRAFT_LIMIT = 25;

/** Upper bound for any limit: a typo such as 4000 instead of 40 must fail loudly. */
const MAX_LIMIT = 1_000;

// The id is part of URLs, audit rows and prospect assignments, and it never
// changes once drafts reference it, so it is kept to a boring slug.
const MAILBOX_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// A pin must name one tenant (GUID or verified domain): the multi-tenant
// endpoints `common`/`organizations`/`consumers` would defeat the pin.
const MICROSOFT_TENANT_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

export const mailboxIdSchema = z.string().trim().regex(MAILBOX_ID_PATTERN, {
  message:
    'id must be 1-64 lowercase letters, digits or hyphens, and start and end with a letter or digit',
});

/** Identities are compared case-insensitively everywhere, so they are stored lowercased. */
export const identityEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'must be an email address' }));

const limitSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_LIMIT, { message: `must be at most ${MAX_LIMIT}` });

export const mailboxRegistryEntrySchema = z
  .strictObject({
    id: mailboxIdSchema,
    provider: z.enum(MAILBOX_PROVIDERS),
    emailAddress: identityEmailSchema,
    aliases: z.array(identityEmailSchema).default([]),
    displayName: z.string().trim().min(1).max(120).optional(),
    // null clears an existing pin; omitted keeps whatever is stored.
    microsoftTenantId: z
      .string()
      .trim()
      .regex(MICROSOFT_TENANT_PATTERN, {
        message: 'microsoftTenantId must be a tenant GUID or a verified domain',
      })
      .nullable()
      .optional(),
    routingPriority: z.number().int().min(0).max(1_000_000).optional(),
    perRunDraftLimit: limitSchema.optional(),
    dailyDraftLimit: limitSchema.optional(),
    /** Daily send limit per sending identity (primary address or alias). */
    sendLimits: z.record(z.string(), limitSchema).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((entry, context) => {
    const seen = new Set<string>([entry.emailAddress]);
    for (const [index, alias] of entry.aliases.entries()) {
      if (seen.has(alias)) {
        context.addIssue({
          code: 'custom',
          path: ['aliases', index],
          message: `${alias} is listed twice (as the primary address or another alias)`,
        });
      }
      seen.add(alias);
    }
    if (
      entry.provider !== 'microsoft' &&
      entry.microsoftTenantId !== undefined &&
      entry.microsoftTenantId !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['microsoftTenantId'],
        message: 'microsoftTenantId is only valid for microsoft mailboxes',
      });
    }
    for (const identity of Object.keys(entry.sendLimits ?? {})) {
      if (!seen.has(identity.trim().toLowerCase())) {
        context.addIssue({
          code: 'custom',
          path: ['sendLimits', identity],
          message: `${identity} is neither the primary address nor an alias of this mailbox`,
        });
      }
    }
  })
  .transform((entry) =>
    entry.sendLimits === undefined
      ? entry
      : {
          ...entry,
          sendLimits: Object.fromEntries(
            Object.entries(entry.sendLimits).map(([identity, limit]) => [
              identity.trim().toLowerCase(),
              limit,
            ]),
          ),
        },
  );

export type MailboxRegistryEntryInput = z.input<typeof mailboxRegistryEntrySchema>;
export type MailboxRegistryEntry = z.output<typeof mailboxRegistryEntrySchema>;

export const mailboxRegistrySchema = z
  .strictObject({
    // Lets editors that understand JSON Schema annotate the file.
    $schema: z.string().optional(),
    mailboxes: z.array(mailboxRegistryEntrySchema),
  })
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    // One address, one owner: the router resolves a sending identity to exactly
    // one mailbox, so the same address on two mailboxes would be ambiguous.
    const owners = new Map<string, string>();
    for (const [index, entry] of registry.mailboxes.entries()) {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: 'custom',
          path: ['mailboxes', index, 'id'],
          message: `mailbox id ${entry.id} is used twice`,
        });
      }
      ids.add(entry.id);
      for (const identity of mailboxIdentities(entry.emailAddress, entry.aliases)) {
        const owner = owners.get(identity);
        if (owner !== undefined && owner !== entry.id) {
          context.addIssue({
            code: 'custom',
            path: ['mailboxes', index],
            message: `${identity} belongs to both ${owner} and ${entry.id}`,
          });
        }
        owners.set(identity, entry.id);
      }
    }
  });

export type MailboxRegistry = z.output<typeof mailboxRegistrySchema>;

/** Primary address first, then aliases; normalized and de-duplicated. */
export function mailboxIdentities(emailAddress: string, aliases: readonly string[]): string[] {
  return [
    ...new Set(
      [emailAddress, ...aliases].map((address) => address.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

/** The addresses of one mailbox, as the address-ownership check reads them. */
export interface MailboxAddresses {
  id: string;
  emailAddress: string;
  aliases: readonly string[];
}

/**
 * The router maps a sending identity to exactly one mailbox, so an address may
 * not be registered on two of them. Returns a sentence naming the first
 * identity of `mailbox` that one of `others` already owns, or undefined.
 * An entry of `others` with the same id is skipped: a mailbox never conflicts
 * with its own stored addresses.
 */
export function mailboxAddressConflict(
  mailbox: MailboxAddresses,
  others: Iterable<MailboxAddresses>,
): string | undefined {
  const owners = new Map<string, string>();
  for (const other of others) {
    if (other.id === mailbox.id) continue;
    for (const identity of mailboxIdentities(other.emailAddress, other.aliases)) {
      owners.set(identity, other.id);
    }
  }
  for (const identity of mailboxIdentities(mailbox.emailAddress, mailbox.aliases)) {
    const owner = owners.get(identity);
    if (owner !== undefined) return `${identity} already belongs to mailbox ${owner}.`;
  }
  return undefined;
}

/**
 * The account a mailbox's OAuth token was minted for. Once a connection is
 * stored these fields are frozen: the token only works for that account.
 */
export interface MailboxAccount {
  provider: MailboxProvider;
  emailAddress: string;
  microsoftTenantId: string | null;
}

export type MailboxAccountField = keyof MailboxAccount;

export const MAILBOX_ACCOUNT_LOCK_EXPLANATION =
  'Provider, primary address and Microsoft tenant are locked because this mailbox has an OAuth ' +
  'connection. Its token only works for that account. To use a different account, add a new mailbox.';

/**
 * The account fields `next` would change on `current`. Addresses compare
 * case-insensitively, and a tenant only matters on a Microsoft mailbox, so a
 * leftover pin on another provider never reads as an account change.
 */
export function changedAccountFields(
  next: MailboxAccount,
  current: MailboxAccount,
): MailboxAccountField[] {
  const tenantOf = (account: MailboxAccount) =>
    account.provider === 'microsoft' ? account.microsoftTenantId : null;
  const changes: MailboxAccountField[] = [];
  if (next.provider !== current.provider) changes.push('provider');
  if (next.emailAddress.trim().toLowerCase() !== current.emailAddress.trim().toLowerCase()) {
    changes.push('emailAddress');
  }
  if (tenantOf(next) !== tenantOf(current)) changes.push('microsoftTenantId');
  return changes;
}

/**
 * The lock the dashboard and the seed both enforce: the account fields a write
 * may not change because the mailbox has a stored OAuth connection, whatever
 * its status. Empty means the write is allowed.
 */
export function lockedAccountChanges(
  next: MailboxAccount,
  current: MailboxAccount,
  hasOAuthConnection: boolean,
): MailboxAccountField[] {
  return hasOAuthConnection ? changedAccountFields(next, current) : [];
}

/** What is already stored for a mailbox; omitted registry fields fall back to it. */
export interface StoredMailboxSettings {
  emailAddress: string;
  aliases: readonly string[];
  displayName: string;
  microsoftTenantId: string | null;
  routingPriority: number;
  perRunDraftLimit: number;
  dailyDraftLimit: number;
  dailySendLimit: number;
  dailySendLimitsByIdentity: Readonly<Record<string, number>>;
  enabled: boolean;
}

/** Every column the registry owns, ready for an insert or an update. */
export interface MailboxRecord {
  id: string;
  provider: MailboxProvider;
  emailAddress: string;
  aliases: string[];
  displayName: string;
  microsoftTenantId: string | null;
  routingPriority: number;
  perRunDraftLimit: number;
  dailyDraftLimit: number;
  dailySendLimit: number;
  dailySendLimitsByIdentity: Record<string, number>;
  enabled: boolean;
}

/**
 * Turns a registry entry into the stored row. A field the entry omits keeps
 * its stored value, so re-seeding or editing one field never silently resets
 * limits an operator raised later; on a new mailbox it takes the conservative
 * default. Each identity gets its own send limit, and the mailbox aggregate is
 * their sum, so neither cap can be reached before the other by accident.
 */
export function resolveMailboxRecord(
  entry: MailboxRegistryEntry,
  stored: StoredMailboxSettings | undefined,
  defaultRoutingPriority: number,
): MailboxRecord {
  const identities = mailboxIdentities(entry.emailAddress, entry.aliases);
  const dailySendLimitsByIdentity = Object.fromEntries(
    identities.map((identity) => [
      identity,
      entry.sendLimits?.[identity] ??
        storedIdentityLimit(stored, identity) ??
        WARM_UP_DAILY_SEND_LIMIT,
    ]),
  );
  return {
    id: entry.id,
    provider: entry.provider,
    emailAddress: entry.emailAddress,
    aliases: identities.slice(1),
    displayName: entry.displayName ?? stored?.displayName ?? entry.emailAddress,
    // A pin outside Microsoft means nothing, and keeping a stored one would
    // leave a stale tenant behind when a mailbox moves to another provider.
    microsoftTenantId:
      entry.provider !== 'microsoft'
        ? null
        : entry.microsoftTenantId === undefined
          ? (stored?.microsoftTenantId ?? null)
          : entry.microsoftTenantId,
    routingPriority: entry.routingPriority ?? stored?.routingPriority ?? defaultRoutingPriority,
    perRunDraftLimit:
      entry.perRunDraftLimit ?? stored?.perRunDraftLimit ?? DEFAULT_PER_RUN_DRAFT_LIMIT,
    dailyDraftLimit: entry.dailyDraftLimit ?? stored?.dailyDraftLimit ?? DEFAULT_DAILY_DRAFT_LIMIT,
    dailySendLimit: Object.values(dailySendLimitsByIdentity).reduce(
      (total, limit) => total + limit,
      0,
    ),
    dailySendLimitsByIdentity,
    enabled: entry.enabled ?? stored?.enabled ?? true,
  };
}

/**
 * The limit the send path enforces today for an identity the mailbox already
 * had: its own entry when valid, else the mailbox aggregate (the same fallback
 * as the send claim), so saving an untouched form changes nothing. A new
 * identity has no history and gets the warm-up default instead.
 */
function storedIdentityLimit(
  stored: StoredMailboxSettings | undefined,
  identity: string,
): number | undefined {
  if (stored === undefined) return undefined;
  if (!mailboxIdentities(stored.emailAddress, stored.aliases).includes(identity)) return undefined;
  const limit = stored.dailySendLimitsByIdentity[identity];
  if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 0) return limit;
  return stored.dailySendLimit;
}

/** One line per problem, with its path, for CLI output and the dashboard. */
export function formatRegistryIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('\n');
}
