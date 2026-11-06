import { readFile } from 'node:fs/promises';
import {
  formatRegistryIssues,
  lockedAccountChanges,
  MAILBOX_ACCOUNT_LOCK_EXPLANATION,
  mailboxAddressConflict,
  mailboxRegistrySchema,
  resolveMailboxRecord,
  type MailboxAccount,
  type MailboxRecord,
  type MailboxRegistry,
  type StoredMailboxSettings,
} from '@yempik/core';

export class MailboxRegistryError extends Error {
  override readonly name = 'MailboxRegistryError';
}

/**
 * Reads and validates a registry file. Returns undefined only when the file is
 * absent and `optional` is set: the default path may legitimately not exist
 * on a deployment that manages its mailboxes from the dashboard.
 */
export async function readMailboxRegistry(
  path: string,
  options: { optional?: boolean } = {},
): Promise<MailboxRegistry | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT' && options.optional) return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    throw new MailboxRegistryError(`Cannot read the mailbox registry ${path}: ${reason}`, {
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MailboxRegistryError(`${path} is not valid JSON: ${reason}`, { cause: error });
  }
  const parsed = mailboxRegistrySchema.safeParse(json);
  if (!parsed.success) {
    throw new MailboxRegistryError(
      `${path} is not a valid mailbox registry:\n${formatRegistryIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * The rows the seed writes. A mailbox without `routingPriority` defaults to its
 * 1-based position in the file, which keeps the file order meaningful.
 */
export function planMailboxSeed(
  registry: MailboxRegistry,
  stored: ReadonlyMap<string, StoredMailboxSettings>,
): MailboxRecord[] {
  return registry.mailboxes.map((entry, index) =>
    resolveMailboxRecord(entry, stored.get(entry.id), index + 1),
  );
}

/** A mailbox row already in the database, as the seed checks the plan against it. */
export interface ExistingMailbox extends StoredMailboxSettings, MailboxAccount {
  id: string;
  hasOAuthConnection: boolean;
}

/**
 * Refuses a plan the dashboard would refuse, before anything is written:
 * changing the account of a mailbox with an OAuth connection, or claiming an
 * address another mailbox in the database owns. Every problem is reported at
 * once, so one fix round is enough.
 *
 * Only mailboxes absent from the file count as other owners: those the file
 * lists get the addresses the file gives them in the same seed, and the schema
 * already guarantees the file assigns each address once. Moving an alias
 * between two mailboxes of the file is therefore one seed, not two.
 */
export function assertMailboxSeedAllowed(
  plan: readonly MailboxRecord[],
  existing: readonly ExistingMailbox[],
): void {
  const byId = new Map(existing.map((mailbox) => [mailbox.id, mailbox]));
  const planned = new Set(plan.map((record) => record.id));
  const untouched = existing.filter((mailbox) => !planned.has(mailbox.id));
  const problems: string[] = [];
  for (const record of plan) {
    const current = byId.get(record.id);
    if (current !== undefined) {
      const locked = lockedAccountChanges(record, current, current.hasOAuthConnection);
      if (locked.length > 0) {
        problems.push(
          `mailbox ${record.id}: the file changes ${locked.join(', ')}. ${MAILBOX_ACCOUNT_LOCK_EXPLANATION}`,
        );
      }
    }
    const conflict = mailboxAddressConflict(record, untouched);
    if (conflict !== undefined) problems.push(`mailbox ${record.id}: ${conflict}`);
  }
  if (problems.length > 0) {
    throw new MailboxRegistryError(
      `The mailbox registry was not seeded, nothing was written:\n${problems.join('\n')}`,
    );
  }
}
