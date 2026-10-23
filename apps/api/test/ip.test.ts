// Challenge 2 (required): one IP, one payer. Plus the optional "restore" challenge.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.ts';
import { advanceClock } from '../src/clock.ts';
import { createServer, moveIp, releaseIp, restoreServer, terminateServer } from '../src/servers.ts';
import { runBilling } from '../src/billing.ts';
import { createTestDb, key, makeCustomer, markRunning, setClock } from './helpers.ts';

let db: Db;
let drop: () => Promise<void>;
beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  await setClock(db, '2030-03-01T10:00:00Z');
});
afterAll(async () => drop());

async function server(customerId?: string) {
  const customer = customerId ?? (await makeCustomer(db));
  const { server } = await createServer(db, { customerId: customer, name: `s-${key().slice(0, 8)}`, idempotencyKey: key(), staffId: null });
  await markRunning(db, server.id);
  return { id: server.id, customerId: customer };
}

const ipOf = async (serverId: string) =>
  (await db.query<{ ip_id: number }>('select ip_id from ip_assignments where server_id = $1 and upper_inf(during) order by id limit 1', [serverId])).rows[0]!.ip_id;

const openHolders = async (ipId: number) =>
  (await db.query<{ server_id: string }>('select server_id from ip_assignments where ip_id = $1 and upper_inf(during)', [ipId])).rows.map((r) => r.server_id);

describe('one IP, one payer (required challenge)', () => {
  it('two simultaneous moves of one IP: exactly one succeeds', async () => {
    for (let round = 0; round < 10; round++) {
      const a = await server();
      const b = await server();
      const c = await server();
      const ipId = await ipOf(a.id);
      await advanceClock(db, 60);

      const results = await Promise.allSettled([
        moveIp(db, { ipId, fromServerId: a.id, toServerId: b.id, staffId: null }),
        moveIp(db, { ipId, fromServerId: a.id, toServerId: c.id, staffId: null }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      // refused either by the IP row lock + source check (409) or, if the code ever loses that
      // lock, by the exclusion constraint itself (23P01)
      expect(['ip_not_on_source', '23P01']).toContain(failed[0]!.reason.code);
      const holders = await openHolders(ipId);
      expect(holders).toHaveLength(1);
      expect([b.id, c.id]).toContain(holders[0]);
    }
  });

  it('the database refuses two overlapping holders of one IP, whatever the code does', async () => {
    const a = await server();
    const b = await server();
    const ipId = await ipOf(a.id);
    await expect(
      db.query("insert into ip_assignments (ip_id, server_id, customer_id, during) values ($1, $2, $3, tstzrange(app_now() - interval '1 minute', null))", [
        ipId,
        b.id,
        b.customerId,
      ]),
    ).rejects.toMatchObject({ code: '23P01' }); // exclusion_violation
  });

  it('the database refuses an assignment whose customer is not the server owner', async () => {
    const a = await server();
    const stranger = await makeCustomer(db);
    const free = (await db.query<{ id: number }>('select id from ip_addresses ip where not exists (select 1 from ip_assignments x where x.ip_id = ip.id and upper_inf(x.during)) limit 1')).rows[0]!.id;
    await expect(
      db.query('insert into ip_assignments (ip_id, server_id, customer_id, during) values ($1, $2, $3, tstzrange(app_now(), null))', [free, a.id, stranger]),
    ).rejects.toMatchObject({ code: '23503' }); // foreign_key_violation on (server_id, customer_id)
  });

  it('an IP cannot be moved onto a server that is being terminated, even concurrently', async () => {
    for (let round = 0; round < 10; round++) {
      const a = await server();
      const b = await server();
      const ipId = await ipOf(a.id);
      await advanceClock(db, 60);
      await Promise.allSettled([
        moveIp(db, { ipId, fromServerId: a.id, toServerId: b.id, staffId: null }),
        terminateServer(db, { serverId: b.id, staffId: null, reason: '' }),
      ]);
      // whatever the interleaving, no IP stays attached to the terminated server
      const onB = await db.query('select 1 from ip_assignments where server_id = $1 and upper_inf(during)', [b.id]);
      expect(onB.rowCount).toBe(0);
    }
  });

  it('a retried move that already happened is a no-op, a move from the wrong source is refused', async () => {
    const a = await server();
    const b = await server();
    const ipId = await ipOf(a.id);
    await advanceClock(db, 60);
    expect(await moveIp(db, { ipId, fromServerId: a.id, toServerId: b.id, staffId: null })).toEqual({ moved: true });
    expect(await moveIp(db, { ipId, fromServerId: a.id, toServerId: b.id, staffId: null })).toEqual({ moved: false });
    const c = await server();
    await expect(moveIp(db, { ipId, fromServerId: a.id, toServerId: c.id, staffId: null })).rejects.toMatchObject({ code: 'ip_not_on_source' });
  });

  it('an IP that moves between customers is never billed to both for the same hour', async () => {
    await setClock(db, '2030-03-05T10:00:00Z');
    const a = await server();
    const b = await server();
    const ipId = await ipOf(a.id);
    // bounce the IP between the two customers several times within a few hours
    let from = a;
    let to = b;
    for (let i = 0; i < 6; i++) {
      await advanceClock(db, 25 * 60);
      await moveIp(db, { ipId, fromServerId: from.id, toServerId: to.id, staffId: null });
      [from, to] = [to, from];
    }
    await runBilling(db);
    const { rows } = await db.query<{ hour_start: Date; payers: number }>(
      "select hour_start, count(distinct customer_id)::int as payers from ledger_entries where ip_id = $1 and kind = 'charge' and hour_start >= '2030-03-05' group by hour_start",
      [ipId],
    );
    expect(rows.length).toBe(3); // 10:00 .. 12:30 -> hours 10, 11, 12
    expect(rows.every((r) => r.payers === 1)).toBe(true);
  });

  it('a released IP is not billed after it was released', async () => {
    await setClock(db, '2030-03-06T10:10:00Z');
    const a = await server();
    const ipId = await ipOf(a.id);
    await advanceClock(db, 30 * 60); // 10:40
    await releaseIp(db, { serverId: a.id, ipId, staffId: null });
    await advanceClock(db, 5 * 3600);
    await runBilling(db);
    const charged = await db.query("select 1 from ledger_entries where ip_id = $1 and hour_start >= '2030-03-06'", [ipId]);
    expect(charged.rowCount).toBe(1); // only 10:00
  });
});

describe('restore (optional challenge)', () => {
  beforeAll(async () => {
    // the pool has 50 addresses; free the ones used by the tests above
    const alive = await db.query<{ id: string }>("select id from servers where status in ('pending', 'provisioning', 'running')");
    for (const { id } of alive.rows) await terminateServer(db, { serverId: id, staffId: null, reason: 'test cleanup' });
    await advanceClock(db, 60);
  });

  it('gets its old IP back when nobody holds it', async () => {
    const a = await server();
    const ipId = await ipOf(a.id);
    await advanceClock(db, 600);
    await terminateServer(db, { serverId: a.id, staffId: null, reason: '' });
    await db.query("update servers set status = 'terminated' where id = $1", [a.id]); // the worker confirmed deletion
    await advanceClock(db, 600);
    const result = await restoreServer(db, { serverId: a.id, staffId: null });
    expect(result.oldIpRestored).toBe(true);
    expect(await ipOf(a.id)).toBe(ipId);
    expect(result.server.status).toBe('pending');
  });

  it('gets another IP when its old one was taken, and refuses after the window', async () => {
    const a = await server();
    const oldIp = await ipOf(a.id);
    await advanceClock(db, 600);
    await terminateServer(db, { serverId: a.id, staffId: null, reason: '' });
    await db.query("update servers set status = 'terminated' where id = $1", [a.id]);
    await advanceClock(db, 600);
    // someone else takes the freed IP
    const b = await server();
    const extra = await db.query<{ ip_id: number }>('select ip_id from ip_assignments where server_id = $1', [b.id]);
    if (extra.rows[0]!.ip_id !== oldIp) {
      await db.query('update ip_assignments set during = tstzrange(lower(during), app_now()) where server_id = $1 and upper_inf(during)', [b.id]);
      await advanceClock(db, 60);
      await db.query('insert into ip_assignments (ip_id, server_id, customer_id, during) values ($1, $2, $3, tstzrange(app_now(), null))', [oldIp, b.id, b.customerId]);
    }
    const result = await restoreServer(db, { serverId: a.id, staffId: null });
    expect(result.oldIpRestored).toBe(false);
    expect(await ipOf(a.id)).not.toBe(oldIp);

    const c = await server();
    await terminateServer(db, { serverId: c.id, staffId: null, reason: '' });
    await db.query("update servers set status = 'terminated' where id = $1", [c.id]);
    await advanceClock(db, 25 * 3600);
    await expect(restoreServer(db, { serverId: c.id, staffId: null })).rejects.toMatchObject({ code: 'restore_window_passed' });
  });
});
