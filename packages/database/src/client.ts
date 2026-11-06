import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.js';

export function createDatabase(
  databaseUrl: string,
  poolConfig: Omit<PoolConfig, 'connectionString'> = {},
) {
  const pool = new Pool({ connectionString: databaseUrl, ...poolConfig });
  return { pool, db: drizzle(pool, { schema }) };
}

export type Database = ReturnType<typeof createDatabase>['db'];
