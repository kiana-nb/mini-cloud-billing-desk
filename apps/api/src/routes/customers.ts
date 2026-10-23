import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { withTx } from '../db.ts';
import { notFound, conflict } from '../errors.ts';
import { idempotencyKey, parse, staffOf, zs } from '../http.ts';
import { balanceOf, refundCharge, topUp } from '../ledger.ts';
import { audit } from '../audit.ts';
import { likePattern, serverListSelect } from './servers.ts';

const statusValues = ['verified', 'payment_notice', 'suspended'] as const;

const listQuery = z
  .object({
    q: zs.search.optional(),
    status: zs.csvEnum([...statusValues]).optional(),
    page: zs.page,
    page_size: zs.pageSize,
  })
  .strict();

const ledgerQuery = z
  .object({ kind: zs.csvEnum(['topup', 'charge', 'refund']).optional(), page: zs.page, page_size: zs.pageSize })
  .strict();

const idParams = z.object({ id: zs.uuid }).strict();

export function customerRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/customers', { config: { permission: 'read' } }, async (req) => {
    const q = parse(listQuery, req.query, 'query');
    const where = `where ($1::text is null or c.name ilike $1 or c.email ilike $1)
      and ($2::customer_status[] is null or exists (
        select 1 from customer_statuses st where st.customer_id = c.id and st.cleared_at is null and st.status = any($2)))`;
    const args = [q.q ? likePattern(q.q) : null, q.status ?? null];
    const [items, total] = await Promise.all([
      db.query(
        `select c.id, c.name, c.email, c.created_at,
           (select coalesce(sum(amount), 0)::bigint from ledger_entries l where l.customer_id = c.id) as balance,
           array(select status::text from customer_statuses st where st.customer_id = c.id and st.cleared_at is null order by status) as statuses,
           (select count(*)::int from servers s where s.customer_id = c.id and s.status in ('pending', 'provisioning', 'running')) as active_servers
         from customers c ${where}
         order by c.name, c.id limit $3 offset $4`,
        [...args, q.page_size, (q.page - 1) * q.page_size],
      ),
      db.query<{ n: number }>(`select count(*)::int as n from customers c ${where}`, args),
    ]);
    return { items: items.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
  });

  app.post('/api/customers', { config: { permission: 'operate' } }, async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().toLowerCase().email() }).strict(), req.body, 'body');
    const staff = staffOf(req);
    const created = await withTx(db, async (tx) => {
      const row = (
        await tx.query('insert into customers (name, email) values ($1, $2) on conflict (email) do nothing returning *', [body.name, body.email])
      ).rows[0];
      if (!row) throw conflict('email_taken', 'a customer with this email already exists');
      await audit(tx, staff.id, 'customer.create', `customer:${row.id}`, body);
      return row;
    });
    return reply.code(201).send(created);
  });

  app.get('/api/customers/:id', { config: { permission: 'read' } }, async (req) => {
    const { id } = parse(idParams, req.params, 'params');
    const customer = (await db.query('select * from customers where id = $1', [id])).rows[0];
    if (!customer) throw notFound('customer');
    const [balance, statuses, servers] = await Promise.all([
      balanceOf(db, id),
      db.query('select status, set_at, cleared_at, reason from customer_statuses where customer_id = $1 order by set_at desc, id desc', [id]),
      db.query(`${serverListSelect} where s.customer_id = $1 order by s.created_at desc, s.id`, [id]),
    ]);
    return {
      customer,
      balance,
      statuses: statuses.rows.filter((s) => s.cleared_at === null).map((s) => s.status),
      status_history: statuses.rows,
      servers: servers.rows,
    };
  });

  app.get('/api/customers/:id/ledger', { config: { permission: 'read' } }, async (req) => {
    const { id } = parse(idParams, req.params, 'params');
    const q = parse(ledgerQuery, req.query, 'query');
    const args = [id, q.kind ?? null];
    const where = 'where l.customer_id = $1 and ($2::ledger_kind[] is null or l.kind = any($2))';
    const [items, total] = await Promise.all([
      db.query(
        `select l.id, l.kind, l.amount, l.created_at, l.description, l.refund_of, l.server_id, l.ip_id, l.holder_server_id, l.hour_start,
           exists (select 1 from ledger_entries r where r.refund_of = l.id) as refunded
         from ledger_entries l ${where} order by l.id desc limit $3 offset $4`,
        [...args, q.page_size, (q.page - 1) * q.page_size],
      ),
      db.query<{ n: number }>(`select count(*)::int as n from ledger_entries l ${where}`, args),
    ]);
    return { items: items.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
  });

  app.post('/api/customers/:id/topups', { config: { permission: 'money' } }, async (req, reply) => {
    const { id } = parse(idParams, req.params, 'params');
    const body = parse(
      z.object({ amount: z.number().int().positive().max(1_000_000_000), description: z.string().trim().max(200).default('') }).strict(),
      req.body,
      'body',
    );
    const result = await topUp(db, { customerId: id, amount: body.amount, description: body.description, idempotencyKey: idempotencyKey(req), staffId: staffOf(req).id });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.post('/api/ledger/:id/refund', { config: { permission: 'money' } }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }).strict(), req.params, 'params');
    const body = parse(z.object({ reason: z.string().trim().max(200).default('') }).strict(), req.body, 'body');
    const result = await refundCharge(db, { entryId: id, reason: body.reason, staffId: staffOf(req).id });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  const statusParams = z.object({ id: zs.uuid, status: z.enum(statusValues) }).strict();

  app.put('/api/customers/:id/statuses/:status', { config: { permission: 'operate' } }, async (req) => {
    const { id, status } = parse(statusParams, req.params, 'params');
    const body = parse(z.object({ reason: z.string().trim().max(200).default('') }).strict(), req.body, 'body');
    const staff = staffOf(req);
    await withTx(db, async (tx) => {
      // lock the customer so a status change and a server creation do not interleave
      const customer = await tx.query('select id from customers where id = $1 for update', [id]);
      if (!customer.rowCount) throw notFound('customer');
      const inserted = await tx.query(
        `insert into customer_statuses (customer_id, status, reason) values ($1, $2, $3)
         on conflict (customer_id, status) where cleared_at is null do nothing`,
        [id, status, body.reason],
      );
      if (inserted.rowCount) await audit(tx, staff.id, 'customer.status.set', `customer:${id}`, { status, reason: body.reason });
    });
    return { ok: true };
  });

  app.delete('/api/customers/:id/statuses/:status', { config: { permission: 'operate' } }, async (req) => {
    const { id, status } = parse(statusParams, req.params, 'params');
    const staff = staffOf(req);
    await withTx(db, async (tx) => {
      const cleared = await tx.query(
        'update customer_statuses set cleared_at = app_now() where customer_id = $1 and status = $2 and cleared_at is null',
        [id, status],
      );
      if (cleared.rowCount) await audit(tx, staff.id, 'customer.status.clear', `customer:${id}`, { status });
    });
    return { ok: true };
  });
}
