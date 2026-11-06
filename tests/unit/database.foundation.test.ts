import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { listPendingMigrations, runMigrations } from '../../packages/database/src/migrate.js';

// The SQL files are read before any connection is opened, so a missing
// directory fails fast with its path and these tests need no Postgres.
const MISSING_DIRECTORY = join(tmpdir(), 'yempik-missing-migrations-directory');
const UNREACHABLE_DATABASE = 'postgres://user:password@127.0.0.1:1/unused';

describe('migrations', () => {
  it('names the directory it could not read when listing', async () => {
    await expect(listPendingMigrations(UNREACHABLE_DATABASE, MISSING_DIRECTORY)).rejects.toThrow(
      `Cannot read the migrations directory ${MISSING_DIRECTORY}`,
    );
  });

  it('names the directory it could not read when running', async () => {
    await expect(runMigrations(UNREACHABLE_DATABASE, MISSING_DIRECTORY)).rejects.toThrow(
      `Cannot read the migrations directory ${MISSING_DIRECTORY}`,
    );
  });
});
