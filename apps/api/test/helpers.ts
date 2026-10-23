// Test helpers. Each test file gets its own fresh database, so files can run in parallel
// and nothing leaks between them.
import { randomBytes, randomUUID } from 'node:crypto';
import { createPool, migrate, type Db } from '../src/db.ts';
import { login } from '../src/auth.ts';
import { seed } from '../src/seed.ts';

const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

export async function createTestDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const name = `bd_test_${randomBytes(6).toString('hex')}`;
  const admin = createPool(adminUrl, 1);
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = createPool(url.toString(), 20);
  await migrate(db);
  return {
    db,
    drop: async () => {
      await db.end();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

/** Freezes the application clock at `iso`. Only for test setup (the API only moves it forward). */
export async function setClock(db: Db, iso: string) {
  await db.query('alter table app_clock disable trigger app_clock_forward_only');
  await db.query('update app_clock set virtual_base = $1, real_base = now(), frozen = true', [iso]);
  await db.query('alter table app_clock enable trigger app_clock_forward_only');
}

export async function makeCustomer(db: Db, balance = 1_000_000): Promise<string> {
  const id = (
    await db.query<{ id: string }>('insert into customers (name, email) values ($1, $2) returning id', [
      `Customer ${randomBytes(3).toString('hex')}`,
      `${randomUUID()}@example.test`,
    ])
  ).rows[0]!.id;
  if (balance > 0) {
    await db.query("insert into ledger_entries (customer_id, kind, amount, idempotency_key) values ($1, 'topup', $2, 'opening')", [id, balance]);
  }
  return id;
}

/** Marks a server as running from the current app time, as the provisioning worker would. */
export async function markRunning(db: Db, serverId: string) {
  await db.query("update servers set status = 'running', running_at = app_now(), infra_id = 'fake-' || id where id = $1", [serverId]);
  await db.query('insert into server_usage (server_id, during) values ($1, tstzrange(app_now(), null))', [serverId]);
}

export async function seedStaffTokens(db: Db) {
  await seed(db);
  const token = async (email: string, password: string) => (await login(db, email, password))!.token;
  return {
    owner: await token('owner@example.com', 'owner-pass'),
    support: await token('support@example.com', 'support-pass'),
    viewer: await token('viewer@example.com', 'viewer-pass'),
  };
}

export async function countCharges(db: Db, where: string, args: unknown[] = []): Promise<number> {
  return (await db.query<{ n: number }>(`select count(*)::int as n from ledger_entries where kind = 'charge' and ${where}`, args)).rows[0]!.n;
}

export const key = () => randomUUID();
