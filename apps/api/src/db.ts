import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// bigint (int8) and numeric come back as strings by default; money is always a safe integer here.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, options: '-c timezone=UTC' });
  // An idle connection can be dropped by the server at any time (restart, failover,
  // network). The pool already discards that client; without a listener node would turn
  // the error event into an uncaught exception and kill the process.
  pool.on('error', (err) => console.error('idle database connection failed, it will be replaced:', err.message));
  return pool;
}

/** Runs `fn` in a transaction. Rolls back on any error and rethrows it. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Applies pending SQL migrations in file name order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  // one migrator at a time, even when several API instances start together
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(42001)');
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(42001)').catch(() => {});
    client.release();
  }
  return applied;
}

/** Postgres error codes the API maps to HTTP answers. */
export const PgCode = {
  uniqueViolation: '23505',
  exclusionViolation: '23P01',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  raiseException: 'P0001',
  serializationFailure: '40001',
  deadlock: '40P01',
} as const;

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
