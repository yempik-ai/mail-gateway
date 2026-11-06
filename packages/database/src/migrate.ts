import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Pool, type PoolClient } from 'pg';

// pnpm runs package scripts from the package directory: load the repo-root .env
// explicitly. Existing environment variables always win (dotenv never overrides).
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

/** Repo-root `migrations/`, as seen from `src/` (tsx) and `dist/` (node) alike. */
const MODULE_MIGRATIONS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);

/**
 * Serializes concurrent runs (two admin clicks, two warm serverless workers).
 * Transaction-scoped on purpose: it is released at COMMIT/ROLLBACK, so it also
 * holds behind a transaction-mode pooler, where a session lock would not.
 */
const MIGRATION_LOCK_KEY = '7265311008';

const MIGRATION_FILE = /^\d+.*\.sql$/;

export interface PendingMigrations {
  /** The directory the SQL files were read from. */
  directory: string;
  /** Versions recorded in `gateway_schema_migrations`, sorted. */
  applied: string[];
  /** Files in `directory` not yet recorded, in the order they would run. */
  pending: string[];
}

/**
 * A migration file failed and was rolled back. Carries what the run had
 * already committed, so a caller can report partial progress precisely.
 */
export class MigrationFailedError extends Error {
  override readonly name = 'MigrationFailedError';

  constructor(
    readonly failedVersion: string,
    readonly applied: readonly string[],
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Migration ${failedVersion} failed and was rolled back: ${reason}`, { cause });
  }
}

export interface MigrationRun {
  directory: string;
  /** Versions applied by this run only; empty when nothing was pending. */
  applied: string[];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The module-relative directory does not survive bundling on Vercel; there the
 * function runs with cwd `/var/task`, and the files shipped via `includeFiles`
 * keep their repo-relative path, so `<cwd>/migrations` is the fallback.
 */
async function resolveMigrationsDirectory(directory?: string): Promise<string> {
  if (directory !== undefined) return directory;
  if (await isDirectory(MODULE_MIGRATIONS_DIRECTORY)) return MODULE_MIGRATIONS_DIRECTORY;
  return resolve(process.cwd(), 'migrations');
}

async function readMigrationFiles(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the migrations directory ${directory}: ${reason}`, {
      cause: error,
    });
  }
  return entries.filter((file) => MIGRATION_FILE.test(file)).sort();
}

/** One connection for the whole run: migrations are sequential by design. */
async function withMigrationClient<T>(
  databaseUrl: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      return await work(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function appliedVersions(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ version: string }>(
    'SELECT version FROM gateway_schema_migrations ORDER BY version',
  );
  return result.rows.map((row) => row.version);
}

export async function listPendingMigrations(
  databaseUrl: string,
  directory?: string,
): Promise<PendingMigrations> {
  const migrationsDirectory = await resolveMigrationsDirectory(directory);
  // Read the files first: a missing directory fails without touching the database.
  const files = await readMigrationFiles(migrationsDirectory);
  return withMigrationClient(databaseUrl, async (client) => {
    const applied = await appliedVersions(client);
    const recorded = new Set(applied);
    return {
      directory: migrationsDirectory,
      applied,
      pending: files.filter((file) => !recorded.has(file)),
    };
  });
}

export async function runMigrations(
  databaseUrl: string,
  directory?: string,
): Promise<MigrationRun> {
  const migrationsDirectory = await resolveMigrationsDirectory(directory);
  const files = await readMigrationFiles(migrationsDirectory);
  return withMigrationClient(databaseUrl, async (client) => {
    const appliedNow: string[] = [];
    for (const file of files) {
      // Read before BEGIN so the lock is never held across file I/O.
      const sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
        // Checked under the lock: a concurrent run may have applied it meanwhile.
        const recorded = await client.query(
          'SELECT 1 FROM gateway_schema_migrations WHERE version = $1',
          [file],
        );
        if (recorded.rowCount !== 0) {
          await client.query('COMMIT');
          continue;
        }
        await client.query(sql);
        await client.query('INSERT INTO gateway_schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedNow.push(file);
      } catch (error) {
        // A failed ROLLBACK (connection already gone) must not mask the cause.
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationFailedError(file, [...appliedNow], error);
      }
    }
    return { directory: migrationsDirectory, applied: appliedNow };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  await runMigrations(databaseUrl);
}
