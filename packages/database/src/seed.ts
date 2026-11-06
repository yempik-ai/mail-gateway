import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  changedAccountFields,
  MAILBOX_ACCOUNT_LOCK_EXPLANATION,
  mailboxSeedConfigSchema,
} from '@yempik/core';

/** pnpm runs package scripts from the package directory, not the repo root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Load the repo-root .env explicitly. Existing environment variables always
// win (dotenv never overrides).
loadDotenv({ path: resolve(REPO_ROOT, '.env') });
import { hashClientSecret } from '@yempik/security';
import { sql } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { mailboxHasOAuthConnection } from './mailbox-lock.js';
import {
  assertMailboxSeedAllowed,
  MailboxRegistryError,
  planMailboxSeed,
  readMailboxRegistry,
  type ExistingMailbox,
} from './mailbox-registry-file.js';
import { mailboxes, mcpClients } from './schema.js';

const DEFAULT_MAILBOXES_FILE = './mailboxes.json';

/** Relative paths are read from the repo root, wherever pnpm runs the script. */
export function resolveMailboxesFile(configured: string | undefined): string {
  const path = configured ?? DEFAULT_MAILBOXES_FILE;
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

export async function seedDatabase(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = mailboxSeedConfigSchema.parse(environment);
  const registryPath = resolveMailboxesFile(config.MAILBOXES_FILE);
  // Validate the file before connecting: a typo must not leave half a seed.
  const registry = await readMailboxRegistry(registryPath, {
    optional: config.MAILBOXES_FILE === undefined,
  });
  const { db, pool } = createDatabase(config.DATABASE_URL);

  try {
    if (registry === undefined) {
      console.log(`No mailbox registry at ${registryPath}: skipping mailboxes.`);
    } else if (registry.mailboxes.length > 0) {
      const ids = registry.mailboxes.map((entry) => entry.id);
      // Every mailbox, not only the file's: address ownership is checked
      // against the whole table, as the dashboard does.
      const existing: ExistingMailbox[] = await db
        .select({
          id: mailboxes.id,
          provider: mailboxes.provider,
          emailAddress: mailboxes.emailAddress,
          aliases: mailboxes.aliases,
          displayName: mailboxes.displayName,
          microsoftTenantId: mailboxes.microsoftTenantId,
          routingPriority: mailboxes.routingPriority,
          perRunDraftLimit: mailboxes.perRunDraftLimit,
          dailyDraftLimit: mailboxes.dailyDraftLimit,
          dailySendLimit: mailboxes.dailySendLimit,
          dailySendLimitsByIdentity: mailboxes.dailySendLimitsByIdentity,
          enabled: mailboxes.enabled,
          hasOAuthConnection: mailboxHasOAuthConnection(sql`${mailboxes}.id`).mapWith(Boolean),
        })
        .from(mailboxes);
      const byId = new Map(existing.map((mailbox) => [mailbox.id, mailbox]));
      const plan = planMailboxSeed(registry, byId);
      assertMailboxSeedAllowed(plan, existing);

      // One transaction: a write refused below rolls back the ones before it,
      // so the registry is applied whole or not at all.
      await db.transaction(async (tx) => {
        for (const mailbox of plan) {
          const current = byId.get(mailbox.id);
          // The lock is checked again in the statement: an OAuth callback may
          // have stored a connection since the read above.
          const movesAccount =
            current !== undefined && changedAccountFields(mailbox, current).length > 0;
          const written = await tx
            .insert(mailboxes)
            .values({ ...mailbox, connectionStatus: 'disconnected' })
            .onConflictDoUpdate({
              target: mailboxes.id,
              set: {
                provider: mailbox.provider,
                emailAddress: mailbox.emailAddress,
                aliases: mailbox.aliases,
                microsoftTenantId: mailbox.microsoftTenantId,
                displayName: mailbox.displayName,
                enabled: mailbox.enabled,
                perRunDraftLimit: mailbox.perRunDraftLimit,
                dailyDraftLimit: mailbox.dailyDraftLimit,
                dailySendLimit: mailbox.dailySendLimit,
                dailySendLimitsByIdentity: mailbox.dailySendLimitsByIdentity,
                routingPriority: mailbox.routingPriority,
                updatedAt: sql`now()`,
              },
              ...(movesAccount
                ? { setWhere: sql`NOT ${mailboxHasOAuthConnection(sql`${mailboxes}.id`)}` }
                : {}),
            })
            .returning({ id: mailboxes.id });
          if (written.length === 0) {
            throw new MailboxRegistryError(
              `The mailbox registry was not seeded, nothing was written:\n` +
                `mailbox ${mailbox.id} was connected while seeding. ${MAILBOX_ACCOUNT_LOCK_EXPLANATION}`,
            );
          }
        }
      });
      console.log(`Seeded ${ids.length} mailbox(es) from ${registryPath}: ${ids.join(', ')}`);
    }

    if (config.MCP_CLIENT_ID && config.MCP_CLIENT_SECRET) {
      const secretHash = await hashClientSecret(config.MCP_CLIENT_SECRET);
      await db
        .insert(mcpClients)
        .values({
          id: config.MCP_CLIENT_ID,
          displayName: 'Bootstrap MCP client',
          secretHash,
          environment: environment.NODE_ENV ?? 'development',
        })
        .onConflictDoUpdate({
          target: mcpClients.id,
          set: {
            secretHash,
            enabled: true,
            allowlisted: true,
            revokedAt: null,
            updatedAt: sql`now()`,
          },
        });
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('/seed.ts') || process.argv[1]?.endsWith('/seed.js')) {
  await seedDatabase();
}
