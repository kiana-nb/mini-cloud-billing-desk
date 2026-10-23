import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { notFound } from '../errors.ts';
import { idempotencyKey, parse, staffOf, zs } from '../http.ts';
import { attachIp, createServer, moveIp, releaseIp, restoreServer, terminateServer } from '../servers.ts';

const serverStatuses = ['pending', 'provisioning', 'running', 'terminating', 'terminated', 'failed'] as const;

/** `%text%` for ILIKE, with the user's own wildcards escaped. */
export const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

export const serverListSelect = `
  select s.id, s.name, s.status, s.created_at, s.running_at, s.terminate_requested_at, s.terminated_at,
         s.restorable_until, s.last_error, s.customer_id, c.name as customer_name,
         array(select host(ip.address) from ip_assignments a join ip_addresses ip on ip.id = a.ip_id
               where a.server_id = s.id and upper_inf(a.during) order by a.id) as ips
  from servers s join customers c on c.id = s.customer_id`;

const sortColumns = { created_at: 's.created_at', name: 's.name', status: 's.status', customer: 'c.name' } as const;

const listQuery = z
  .object({
    q: zs.search.optional(),
    status: zs.csvEnum([...serverStatuses]).optional(),
    customer_id: zs.uuid.optional(),
    sort: z.enum(['created_at', 'name', 'status', 'customer']).default('created_at'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: zs.page,
    page_size: zs.pageSize,
  })
  .strict();

const idParams = z.object({ id: zs.uuid }).strict();

export function serverRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/servers', { config: { permission: 'read' } }, async (req) => {
    const q = parse(listQuery, req.query, 'query');
    const where = `where ($1::text is null or s.name ilike $1 or c.name ilike $1 or c.email ilike $1 or s.id::text = $2
        or exists (select 1 from ip_assignments a join ip_addresses ip on ip.id = a.ip_id
                   where a.server_id = s.id and upper_inf(a.during) and host(ip.address) like $1))
      and ($3::server_status[] is null or s.status = any($3))
      and ($4::uuid is null or s.customer_id = $4)`;
    const args = [q.q ? likePattern(q.q) : null, q.q ?? null, q.status ?? null, q.customer_id ?? null];
    const [items, total] = await Promise.all([
      db.query(`${serverListSelect} ${where} order by ${sortColumns[q.sort]} ${q.order}, s.id limit $5 offset $6`, [
        ...args,
        q.page_size,
        (q.page - 1) * q.page_size,
      ]),
      db.query<{ n: number }>(`select count(*)::int as n from servers s join customers c on c.id = s.customer_id ${where}`, args),
    ]);
    return { items: items.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
  });

  app.post('/api/servers', { config: { permission: 'operate' } }, async (req, reply) => {
    const body = parse(
      z
        .object({
          customer_id: zs.uuid,
          name: z.string().trim().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'lowercase letters, digits and dashes, 1-63 characters'),
        })
        .strict(),
      req.body,
      'body',
    );
    const result = await createServer(db, { customerId: body.customer_id, name: body.name, idempotencyKey: idempotencyKey(req), staffId: staffOf(req).id });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get('/api/servers/:id', { config: { permission: 'read' } }, async (req) => {
    const { id } = parse(idParams, req.params, 'params');
    const server = (await db.query(`${serverListSelect} where s.id = $1`, [id])).rows[0];
    if (!server) throw notFound('server');
    const [ips, usage] = await Promise.all([
      db.query(
        `select a.id as assignment_id, a.ip_id, host(ip.address) as address, lower(a.during) as since, upper(a.during) as until,
                a.customer_id, c.name as customer_name
         from ip_assignments a join ip_addresses ip on ip.id = a.ip_id join customers c on c.id = a.customer_id
         where a.server_id = $1 order by lower(a.during) desc, a.id desc`,
        [id],
      ),
      db.query('select lower(during) as started_at, upper(during) as ended_at from server_usage where server_id = $1 order by lower(during)', [id]),
    ]);
    return {
      server,
      ips: ips.rows.filter((r) => r.until === null),
      ip_history: ips.rows,
      usage: usage.rows,
    };
  });

  app.get('/api/servers/:id/charges', { config: { permission: 'read' } }, async (req) => {
    const { id } = parse(idParams, req.params, 'params');
    const q = parse(z.object({ page: zs.page, page_size: zs.pageSize }).strict(), req.query, 'query');
    const where = 'where l.server_id = $1 or l.holder_server_id = $1';
    const [items, total] = await Promise.all([
      db.query(
        `select l.id, l.kind, l.amount, l.created_at, l.description, l.hour_start, l.ip_id, host(ip.address) as ip_address,
                l.customer_id, p.amount_per_hour as price,
                exists (select 1 from ledger_entries r where r.refund_of = l.id) as refunded
         from ledger_entries l left join ip_addresses ip on ip.id = l.ip_id left join prices p on p.id = l.price_id
         ${where} order by l.hour_start desc, l.id desc limit $2 offset $3`,
        [id, q.page_size, (q.page - 1) * q.page_size],
      ),
      db.query<{ n: number }>(`select count(*)::int as n from ledger_entries l ${where}`, [id]),
    ]);
    return { items: items.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
  });

  app.post('/api/servers/:id/terminate', { config: { permission: 'operate' } }, async (req) => {
    const { id } = parse(idParams, req.params, 'params');
    const body = parse(z.object({ reason: z.string().trim().max(200).default('') }).strict(), req.body, 'body');
    return { server: await terminateServer(db, { serverId: id, staffId: staffOf(req).id, reason: body.reason }) };
  });

  app.post('/api/servers/:id/restore', { config: { permission: 'operate' } }, async (req) => {
    const { id } = parse(idParams, req.params, 'params');
    parse(z.object({}).strict(), req.body, 'body');
    return restoreServer(db, { serverId: id, staffId: staffOf(req).id });
  });

  app.post('/api/servers/:id/ips', { config: { permission: 'operate' } }, async (req, reply) => {
    const { id } = parse(idParams, req.params, 'params');
    parse(z.object({}).strict(), req.body, 'body');
    const result = await attachIp(db, { serverId: id, requestKey: idempotencyKey(req), staffId: staffOf(req).id });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.delete('/api/servers/:id/ips/:ipId', { config: { permission: 'operate' } }, async (req) => {
    const { id, ipId } = parse(z.object({ id: zs.uuid, ipId: z.coerce.number().int().positive() }).strict(), req.params, 'params');
    await releaseIp(db, { serverId: id, ipId, staffId: staffOf(req).id });
    return { ok: true };
  });

  app.get('/api/ips', { config: { permission: 'read' } }, async (req) => {
    const q = parse(
      z.object({ q: zs.search.optional(), state: z.enum(['free', 'assigned']).optional(), page: zs.page, page_size: zs.pageSize }).strict(),
      req.query,
      'query',
    );
    const where = `where ($1::text is null or host(ip.address) like $1 or s.name ilike $1 or c.name ilike $1)
      and ($2::text is null or ($2 = 'free') = (a.id is null))`;
    const from = `from ip_addresses ip
      left join ip_assignments a on a.ip_id = ip.id and upper_inf(a.during)
      left join servers s on s.id = a.server_id left join customers c on c.id = a.customer_id`;
    const args = [q.q ? likePattern(q.q) : null, q.state ?? null];
    const [items, total] = await Promise.all([
      db.query(
        `select ip.id, host(ip.address) as address, a.server_id, s.name as server_name, a.customer_id, c.name as customer_name, lower(a.during) as since
         ${from} ${where} order by ip.address limit $3 offset $4`,
        [...args, q.page_size, (q.page - 1) * q.page_size],
      ),
      db.query<{ n: number }>(`select count(*)::int as n ${from} ${where}`, args),
    ]);
    return { items: items.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
  });

  app.get('/api/ips/:id', { config: { permission: 'read' } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }).strict(), req.params, 'params');
    const ip = (await db.query('select id, host(address) as address from ip_addresses where id = $1', [id])).rows[0];
    if (!ip) throw notFound('IP address');
    const [history, charges] = await Promise.all([
      db.query(
        `select a.id, a.server_id, s.name as server_name, a.customer_id, c.name as customer_name,
                lower(a.during) as since, upper(a.during) as until
         from ip_assignments a join servers s on s.id = a.server_id join customers c on c.id = a.customer_id
         where a.ip_id = $1 order by lower(a.during) desc, a.id desc`,
        [id],
      ),
      db.query(
        `select l.id, l.hour_start, l.amount, l.customer_id, c.name as customer_name, l.holder_server_id, s.name as server_name, l.created_at,
                exists (select 1 from ledger_entries r where r.refund_of = l.id) as refunded
         from ledger_entries l join customers c on c.id = l.customer_id left join servers s on s.id = l.holder_server_id
         where l.ip_id = $1 order by l.hour_start desc limit 200`,
        [id],
      ),
    ]);
    return { ip, history: history.rows, charges: charges.rows };
  });

  app.post('/api/ips/:id/move', { config: { permission: 'operate' } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }).strict(), req.params, 'params');
    const body = parse(z.object({ from_server_id: zs.uuid, to_server_id: zs.uuid }).strict(), req.body, 'body');
    return moveIp(db, { ipId: id, fromServerId: body.from_server_id, toServerId: body.to_server_id, staffId: staffOf(req).id });
  });
}
