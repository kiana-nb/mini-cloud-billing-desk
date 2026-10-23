// Servers and IP addresses: the requests staff make. Talking to the infrastructure is the
// workers' job (workers.ts); a request here only records intent in the database.
import type { Db, Tx } from './db.ts';
import { withTx } from './db.ts';
import { AppError, conflict, notFound } from './errors.ts';
import { audit } from './audit.ts';
import { balanceOf } from './ledger.ts';

export const RESTORE_WINDOW = '24 hours';

export type ServerRow = {
  id: string;
  customer_id: string;
  name: string;
  status: 'pending' | 'provisioning' | 'running' | 'terminating' | 'terminated' | 'failed';
  infra_id: string | null;
  created_at: Date;
  running_at: Date | null;
  terminate_requested_at: Date | null;
  terminated_at: Date | null;
  restorable_until: Date | null;
  last_error: string | null;
};

const ALIVE = ['pending', 'provisioning', 'running'] as const;

/** Ends the server's open usage period now. A period that would be empty is removed. */
export async function closeOpenUsage(tx: Tx, serverId: string) {
  await tx.query('delete from server_usage where server_id = $1 and upper_inf(during) and lower(during) >= app_now()', [serverId]);
  await tx.query('update server_usage set during = tstzrange(lower(during), app_now()) where server_id = $1 and upper_inf(during)', [serverId]);
}

/** Ends open IP assignments (all of a server's, or one) now. Empty periods are removed. */
export async function closeAssignments(tx: Tx, where: { serverId: string } | { assignmentId: number }) {
  const [cond, arg] = 'serverId' in where ? ['server_id = $1', where.serverId] : ['id = $1', where.assignmentId];
  await tx.query(`delete from ip_assignments where ${cond} and upper_inf(during) and lower(during) >= app_now()`, [arg]);
  await tx.query(`update ip_assignments set during = tstzrange(lower(during), app_now()) where ${cond} and upper_inf(during)`, [arg]);
}

/** Locks and returns a free IP, preferring `preferredIpId`. Locking the IP row serialises all changes to one IP. */
async function takeFreeIp(tx: Tx, preferredIpId?: number): Promise<{ id: number; address: string } | null> {
  const tried: number[] = [];
  for (;;) {
    const { rows } = await tx.query<{ id: number; address: string }>(
      `select ip.id, host(ip.address) as address from ip_addresses ip
       where not exists (select 1 from ip_assignments a where a.ip_id = ip.id and upper_inf(a.during))
         and ip.id <> all($2::int[])
       order by (ip.id = $1) desc nulls last, ip.id
       for update skip locked limit 1`,
      [preferredIpId ?? null, tried],
    );
    const ip = rows[0];
    if (!ip) return null;
    // The row lock was taken after the snapshot; re-check that nobody attached it meanwhile.
    const held = await tx.query('select 1 from ip_assignments where ip_id = $1 and upper_inf(during)', [ip.id]);
    if (!held.rowCount) return ip;
    tried.push(ip.id);
  }
}

async function assignIp(tx: Tx, ipId: number, server: { id: string; customer_id: string }, requestKey: string | null) {
  await tx.query(
    `insert into ip_assignments (ip_id, server_id, customer_id, during, request_key)
     values ($1, $2, $3, tstzrange(app_now(), null), $4)`,
    [ipId, server.id, server.customer_id, requestKey],
  );
}

async function assertCustomerMayCreate(tx: Tx, customerId: string) {
  const customer = await tx.query('select id from customers where id = $1 for share', [customerId]);
  if (customer.rowCount === 0) throw notFound('customer');
  const suspended = await tx.query(
    "select 1 from customer_statuses where customer_id = $1 and status = 'suspended' and cleared_at is null",
    [customerId],
  );
  if (suspended.rowCount) throw conflict('customer_suspended', 'the customer is suspended');
  if ((await balanceOf(tx, customerId)) <= 0) throw conflict('insufficient_balance', 'the customer has no money in the wallet');
}

/**
 * Records a new server and gives it an IP. Safe to retry: the same idempotency key returns
 * the server created by the first request (unique (customer_id, idempotency_key)).
 */
export async function createServer(
  db: Db,
  input: { customerId: string; name: string; idempotencyKey: string; staffId: string | null },
): Promise<{ server: ServerRow; replayed: boolean }> {
  return withTx(db, async (tx) => {
    const previous = (
      await tx.query<ServerRow>('select * from servers where customer_id = $1 and idempotency_key = $2', [input.customerId, input.idempotencyKey])
    ).rows[0];
    if (previous) return replay(previous, input.name);

    await assertCustomerMayCreate(tx, input.customerId);
    const inserted = await tx.query<ServerRow>(
      `insert into servers (customer_id, name, idempotency_key) values ($1, $2, $3)
       on conflict (customer_id, idempotency_key) do nothing returning *`,
      [input.customerId, input.name, input.idempotencyKey],
    );
    const server = inserted.rows[0];
    if (!server) {
      // a concurrent request with the same key won; answer with its server
      const winner = (
        await tx.query<ServerRow>('select * from servers where customer_id = $1 and idempotency_key = $2', [input.customerId, input.idempotencyKey])
      ).rows[0]!;
      return replay(winner, input.name);
    }
    const ip = await takeFreeIp(tx);
    if (!ip) throw conflict('ip_pool_exhausted', 'no free IP address is left in the pool');
    await assignIp(tx, ip.id, server, null);
    await audit(tx, input.staffId, 'server.create', `server:${server.id}`, { name: server.name, ip: ip.address });
    return { server, replayed: false };
  });

  function replay(server: ServerRow, name: string) {
    if (server.name !== name) throw new AppError(409, 'idempotency_key_reused', 'this idempotency key was already used for another server');
    return { server, replayed: true };
  }
}

/**
 * Asks for termination. Billing stops now: the usage period and the IP assignments end
 * immediately; the worker deletes the infrastructure server afterwards. Repeating the
 * request is harmless.
 */
export async function terminateServer(db: Db, input: { serverId: string; staffId: string | null; reason: string }): Promise<ServerRow> {
  return withTx(db, async (tx) => {
    const server = (await tx.query<ServerRow>('select * from servers where id = $1 for update', [input.serverId])).rows[0];
    if (!server) throw notFound('server');
    if (!ALIVE.includes(server.status as (typeof ALIVE)[number])) return server;
    await closeOpenUsage(tx, server.id);
    await closeAssignments(tx, { serverId: server.id });
    const updated = await tx.query<ServerRow>(
      `update servers set status = 'terminating', terminate_requested_at = app_now(),
         restorable_until = app_now() + $2::interval, attempts = 0, next_attempt_at = now(), last_error = null
       where id = $1 returning *`,
      [server.id, RESTORE_WINDOW],
    );
    await audit(tx, input.staffId, 'server.terminate', `server:${server.id}`, { reason: input.reason });
    return updated.rows[0]!;
  });
}

/**
 * Brings a terminated server back within the restore window. It gets its last IP back only
 * if that IP is free; otherwise it gets another one from the pool.
 */
export async function restoreServer(db: Db, input: { serverId: string; staffId: string | null }): Promise<{ server: ServerRow; oldIpRestored: boolean }> {
  return withTx(db, async (tx) => {
    const server = (await tx.query<ServerRow>('select * from servers where id = $1 for update', [input.serverId])).rows[0];
    if (!server) throw notFound('server');
    if (server.status !== 'terminated') throw conflict('not_restorable', `a ${server.status} server cannot be restored`);
    const inWindow = await tx.query('select 1 from servers where id = $1 and restorable_until >= app_now()', [server.id]);
    if (!inWindow.rowCount) throw conflict('restore_window_passed', 'the restore window has passed');
    await assertCustomerMayCreate(tx, server.customer_id);

    const lastIp = (
      await tx.query<{ ip_id: number }>('select ip_id from ip_assignments where server_id = $1 order by upper(during) desc nulls first, id desc limit 1', [server.id])
    ).rows[0];
    const ip = await takeFreeIp(tx, lastIp?.ip_id);
    if (!ip) throw conflict('ip_pool_exhausted', 'no free IP address is left in the pool');

    const updated = await tx.query<ServerRow>(
      `update servers set status = 'pending', infra_id = null, infra_linked_at = null, running_at = null,
         terminate_requested_at = null, terminated_at = null, restorable_until = null,
         attempts = 0, next_attempt_at = now(), lease_until = null, last_error = null
       where id = $1 returning *`,
      [server.id],
    );
    await assignIp(tx, ip.id, server, null);
    const oldIpRestored = ip.id === lastIp?.ip_id;
    await audit(tx, input.staffId, 'server.restore', `server:${server.id}`, { previousInfraId: server.infra_id, ip: ip.address, oldIpRestored });
    return { server: updated.rows[0]!, oldIpRestored };
  });
}

/** Attaches one more IP from the pool. The request key makes a retry return the same IP. */
export async function attachIp(db: Db, input: { serverId: string; requestKey: string; staffId: string | null }): Promise<{ ipId: number; replayed: boolean }> {
  return withTx(db, async (tx) => {
    const server = (await tx.query<ServerRow>('select * from servers where id = $1', [input.serverId])).rows[0];
    if (!server) throw notFound('server');
    const previous = await tx.query<{ ip_id: number }>('select ip_id from ip_assignments where server_id = $1 and request_key = $2', [
      server.id,
      input.requestKey,
    ]);
    if (previous.rows[0]) return { ipId: previous.rows[0].ip_id, replayed: true };
    const ip = await takeFreeIp(tx);
    if (!ip) throw conflict('ip_pool_exhausted', 'no free IP address is left in the pool');
    await assignIp(tx, ip.id, server, input.requestKey);
    await audit(tx, input.staffId, 'ip.attach', `ip:${ip.id}`, { server: server.id, address: ip.address });
    return { ipId: ip.id, replayed: false };
  });
}

type OpenAssignment = { id: number; server_id: string; customer_id: string };

async function lockIp(tx: Tx, ipId: number): Promise<OpenAssignment | null> {
  const ip = await tx.query('select id from ip_addresses where id = $1 for update', [ipId]);
  if (!ip.rowCount) throw notFound('IP address');
  const { rows } = await tx.query<OpenAssignment>('select id, server_id, customer_id from ip_assignments where ip_id = $1 and upper_inf(during)', [ipId]);
  return rows[0] ?? null;
}

/** Returns an IP to the pool. Billing for it stops now. */
export async function releaseIp(db: Db, input: { serverId: string; ipId: number; staffId: string | null }): Promise<void> {
  await withTx(db, async (tx) => {
    const current = await lockIp(tx, input.ipId);
    if (current?.server_id !== input.serverId) throw conflict('ip_not_attached', 'the IP is not attached to this server');
    await closeAssignments(tx, { assignmentId: current.id });
    await audit(tx, input.staffId, 'ip.release', `ip:${input.ipId}`, { server: input.serverId });
  });
}

/**
 * Moves an IP from one server to another, possibly of another customer.
 * The caller names the server it believes holds the IP; if someone moved it in the
 * meantime the move is refused instead of silently taking the IP away from someone else.
 * Two simultaneous moves are serialised by the IP row lock; even without the lock the
 * exclusion constraint on ip_assignments rejects the second open assignment.
 * Repeating a move that already happened returns without changes.
 */
export async function moveIp(
  db: Db,
  input: { ipId: number; fromServerId: string; toServerId: string; staffId: string | null },
): Promise<{ moved: boolean }> {
  if (input.fromServerId === input.toServerId) throw new AppError(400, 'same_server', 'source and target are the same server');
  return withTx(db, async (tx) => {
    const current = await lockIp(tx, input.ipId);
    if (current?.server_id === input.toServerId) return { moved: false };
    if (current?.server_id !== input.fromServerId) throw conflict('ip_not_on_source', 'the IP is no longer attached to the source server');
    const target = (await tx.query<ServerRow>('select * from servers where id = $1', [input.toServerId])).rows[0];
    if (!target) throw notFound('target server');
    await closeAssignments(tx, { assignmentId: current.id });
    await assignIp(tx, input.ipId, target, null);
    await audit(tx, input.staffId, 'ip.move', `ip:${input.ipId}`, {
      from: input.fromServerId,
      to: input.toServerId,
      fromCustomer: current.customer_id,
      toCustomer: target.customer_id,
    });
    return { moved: true };
  });
}
