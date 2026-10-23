// The API must survive the database dropping its idle connections (a Postgres restart,
// a failover, a network blip). Without an 'error' handler on the pool, node treats the
// error of an idle client as an uncaught exception and the process dies.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.ts';
import { createPool } from '../src/db.ts';
import { createTestDb } from './helpers.ts';

let db: Db;
let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

describe('connection pool', () => {
  it('survives the server terminating idle connections, and reconnects', async () => {
    // fill the pool with idle connections
    await Promise.all(Array.from({ length: 5 }, () => db.query('select pg_sleep(0.05)')));
    const name = (await db.query<{ db: string }>('select current_database() as db')).rows[0]!.db;

    // another connection kills them, as a restart would
    const admin = createPool(process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres', 1);
    const killed = await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [name]);
    await admin.end();
    expect(killed.rowCount).toBeGreaterThan(0);

    // give the error events time to fire, then the pool must still work
    await new Promise((r) => setTimeout(r, 200));
    expect((await db.query('select 1 as ok')).rows[0]).toEqual({ ok: 1 });
  });
});
