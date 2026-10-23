// Challenge 1 (required): exactly-once billing, plus the optional "downtime",
// "one bad record" and "price change" challenges.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.ts';
import { runBilling } from '../src/billing.ts';
import { advanceClock } from '../src/clock.ts';
import { createServer, moveIp, terminateServer } from '../src/servers.ts';
import { countCharges, createTestDb, key, makeCustomer, markRunning, setClock } from './helpers.ts';

let db: Db;
let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

// Every test starts on a later day with nothing left to bill: servers of earlier tests are
// terminated and settled, so each test only sees its own items.
let day = 1;
beforeEach(async () => {
  day += 1;
  const alive = await db.query<{ id: string }>("select id from servers where status in ('pending', 'provisioning', 'running')");
  for (const { id } of alive.rows) await terminateServer(db, { serverId: id, staffId: null, reason: 'test cleanup' });
  await runBilling(db);
  await setClock(db, `2030-01-${String(day).padStart(2, '0')}T10:30:00Z`);
});

async function runningServer(customerId?: string) {
  const customer = customerId ?? (await makeCustomer(db));
  const { server } = await createServer(db, { customerId: customer, name: `srv-${key().slice(0, 8)}`, idempotencyKey: key(), staffId: null });
  await markRunning(db, server.id);
  return { serverId: server.id, customerId: customer };
}

/** Hours charged per server must be exactly the expected hours, each once. */
async function serverHours(serverId: string): Promise<string[]> {
  const { rows } = await db.query<{ h: Date }>("select hour_start as h from ledger_entries where server_id = $1 and kind = 'charge' order by 1", [serverId]);
  return rows.map((r) => r.h.toISOString().slice(11, 16));
}

describe('hourly billing', () => {
  it('charges every started hour once, for the server and its IP', async () => {
    const { serverId } = await runningServer(); // runs from 10:30
    await advanceClock(db, 100 * 60); // 12:10
    await runBilling(db);
    expect(await serverHours(serverId)).toEqual(['10:00', '11:00', '12:00']);
    expect(await countCharges(db, 'holder_server_id = $1', [serverId])).toBe(3);

    // running it again changes nothing
    const again = await runBilling(db);
    expect(again.chargesCreated).toBe(0);
    expect(await serverHours(serverId)).toEqual(['10:00', '11:00', '12:00']);
  });

  it('stops charging when the server is terminated', async () => {
    const { serverId } = await runningServer(); // 10:30
    await advanceClock(db, 45 * 60); // 11:15
    await terminateServer(db, { serverId, staffId: null, reason: '' });
    await advanceClock(db, 5 * 3600);
    await runBilling(db);
    expect(await serverHours(serverId)).toEqual(['10:00', '11:00']);
  });

  it('never charges a server that has not started running', async () => {
    const customerId = await makeCustomer(db);
    const { server } = await createServer(db, { customerId, name: 'still-provisioning', idempotencyKey: key(), staffId: null });
    await advanceClock(db, 3 * 3600);
    await runBilling(db);
    expect(await countCharges(db, 'server_id = $1 or holder_server_id = $1', [server.id])).toBe(0);
  });
});

describe('exactly-once under concurrency and crashes (required challenge)', () => {
  it('two billing runs at the same moment charge each hour exactly once', async () => {
    const servers = await Promise.all(Array.from({ length: 15 }, () => runningServer()));
    await advanceClock(db, 4 * 3600); // 14:30 -> hours 10..14 = 5 hours each

    const [a, b] = await Promise.all([runBilling(db), runBilling(db)]);
    expect(a.itemsFailed + b.itemsFailed).toBe(0);
    expect(a.itemsFailed + b.itemsFailed).toBe(0);
    expect(a.chargesCreated + b.chargesCreated).toBe(15 * 5 * 2); // server + IP per hour, split between the runs, split between the two runs

    for (const { serverId } of servers) {
      expect(await serverHours(serverId)).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
      expect(await countCharges(db, 'holder_server_id = $1', [serverId])).toBe(5);
    }
  });

  it('a run that crashes halfway is completed by the next run, without duplicates or gaps', async () => {
    const servers = await Promise.all(Array.from({ length: 10 }, () => runningServer()));
    await advanceClock(db, 2 * 3600); // 12:30 -> 3 hours

    await expect(
      runBilling(db, {
        afterItem: (i) => {
          if (i === 6) throw new Error('process killed');
        },
      }),
    ).rejects.toThrow('process killed');
    const partial = await countCharges(db, 'server_id = any($1) or holder_server_id = any($1)', [servers.map((s) => s.serverId)]);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(10 * 3 * 2);

    await runBilling(db);
    for (const { serverId } of servers) {
      expect(await serverHours(serverId)).toEqual(['10:00', '11:00', '12:00']);
      expect(await countCharges(db, 'holder_server_id = $1', [serverId])).toBe(3);
    }
  });

  it('the database itself refuses a second charge for the same server hour', async () => {
    const { serverId, customerId } = await runningServer();
    await runBilling(db);
    const price = (await db.query<{ id: number }>("select id from prices where resource = 'server' limit 1")).rows[0]!.id;
    await expect(
      db.query(
        "insert into ledger_entries (customer_id, kind, amount, server_id, hour_start, price_id) values ($1, 'charge', -100, $2, '2030-01-01T10:00:00Z', $3), ($1, 'charge', -100, $2, '2030-01-01T10:00:00Z', $3)",
        [customerId, serverId, price],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('downtime (optional challenge)', () => {
  it('after hours without billing, every missed hour is charged once', async () => {
    const { serverId } = await runningServer(); // 10:30
    await runBilling(db); // charges 10:00
    await advanceClock(db, 6 * 3600); // billing "down" until 16:30
    await runBilling(db);
    expect(await serverHours(serverId)).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  });
});

describe('one bad record (optional challenge)', () => {
  it('a failing item is reported and everyone else is still billed', async () => {
    const good = await runningServer();
    const bad = await runningServer();
    await advanceClock(db, 3600);
    // a record that keeps failing: any charge for this server is rejected
    await db.query(`create function fail_one() returns trigger language plpgsql as $$
      begin if new.server_id = '${bad.serverId}' then raise exception 'corrupt record'; end if; return new; end $$`);
    await db.query('create trigger fail_one before insert on ledger_entries for each row execute function fail_one()');
    try {
      const result = await runBilling(db);
      expect(result.itemsFailed).toBe(1);
      expect(result.failures[0]).toMatchObject({ resource: 'server', resourceId: bad.serverId });
      expect(await serverHours(good.serverId)).toEqual(['10:00', '11:00']);
      expect(await serverHours(bad.serverId)).toEqual([]);
      // the bad server's IP is a separate item and is billed normally
      expect(await countCharges(db, 'holder_server_id = $1', [bad.serverId])).toBe(2);
      const reported = await db.query('select * from billing_failures where run_id = $1', [result.runId]);
      expect(reported.rowCount).toBe(1);
    } finally {
      await db.query('drop trigger fail_one on ledger_entries');
      await db.query('drop function fail_one');
    }
    // once fixed, the next run catches up
    await runBilling(db);
    expect(await serverHours(bad.serverId)).toEqual(['10:00', '11:00']);
  });
});

describe('price change (optional challenge)', () => {
  it('a new price applies from the next hour and never to hours already charged', async () => {
    const { serverId } = await runningServer(); // 10:30
    await runBilling(db); // hour 10 at the old price
    await db.query(
      "insert into prices (resource, amount_per_hour, effective_from) values ('server', 250, date_trunc('hour', app_now(), 'UTC') + interval '1 hour')",
    );
    await advanceClock(db, 2 * 3600); // 12:30
    await runBilling(db);
    const { rows } = await db.query<{ h: Date; amount: number }>(
      "select hour_start as h, amount from ledger_entries where server_id = $1 and kind = 'charge' order by 1",
      [serverId],
    );
    expect(rows.map((r) => r.amount)).toEqual([-100, -250, -250]);
    // back to the old price for the following tests (later days)
    await db.query("insert into prices (resource, amount_per_hour, effective_from) values ('server', 100, date_trunc('hour', app_now(), 'UTC') + interval '1 hour')");
  });
});

describe('IP billing follows the holder', () => {
  it('an IP moved within an hour is paid once for that hour, by the first holder', async () => {
    const a = await runningServer();
    const b = await runningServer();
    const ipId = (await db.query<{ ip_id: number }>('select ip_id from ip_assignments where server_id = $1', [a.serverId])).rows[0]!.ip_id;
    await advanceClock(db, 10 * 60); // 10:40
    await moveIp(db, { ipId, fromServerId: a.serverId, toServerId: b.serverId, staffId: null });
    await advanceClock(db, 60 * 60); // 11:40
    await runBilling(db);
    const { rows } = await db.query<{ h: Date; customer_id: string }>(
      // the pool is shared with earlier tests (earlier days): look at today only
      "select hour_start as h, customer_id from ledger_entries where ip_id = $1 and kind = 'charge' and hour_start >= date_trunc('day', app_now(), 'UTC') order by 1",
      [ipId],
    );
    expect(rows.map((r) => [r.h.toISOString().slice(11, 16), r.customer_id])).toEqual([
      ['10:00', a.customerId],
      ['11:00', b.customerId],
    ]);
  });
});
