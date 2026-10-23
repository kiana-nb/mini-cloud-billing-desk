import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { withTx } from '../db.ts';
import { AppError } from '../errors.ts';
import { parse, staffOf, zs } from '../http.ts';
import { advanceClock, readClock, setClockFrozen } from '../clock.ts';
import { runBilling } from '../billing.ts';
import { reconcile } from '../workers.ts';
import type { InfraClient } from '../infra-client.ts';
import { audit } from '../audit.ts';
import { login, logout } from '../auth.ts';

const pageQuery = z.object({ page: zs.page, page_size: zs.pageSize }).strict();

export function adminRoutes(app: FastifyInstance, db: Db, infra: InfraClient, infraUrl: string) {
  app.get('/api/health', { config: { permission: 'public' } }, async () => {
    await db.query('select 1');
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { permission: 'public' } }, async (req) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).strict(), req.body, 'body');
    const session = await login(db, body.email, body.password);
    if (!session) throw new AppError(401, 'invalid_credentials', 'wrong email or password');
    return session;
  });

  app.post('/api/auth/logout', { config: { permission: 'read' } }, async (req) => {
    await logout(db, req.headers.authorization!.slice(7));
    return { ok: true };
  });

  app.get('/api/me', { config: { permission: 'read' } }, async (req) => staffOf(req));

  // --- clock (owner only) ---
  app.get('/api/clock', { config: { permission: 'read' } }, async () => readClock(db));

  app.post('/api/clock/advance', { config: { permission: 'system' } }, async (req) => {
    const body = parse(
      z
        .object({ hours: z.number().int().min(0).max(24 * 365).default(0), minutes: z.number().int().min(0).max(60 * 24 * 365).default(0) })
        .strict()
        .refine((b) => b.hours > 0 || b.minutes > 0, 'move the clock forward by at least one minute'),
      req.body,
      'body',
    );
    const clock = await advanceClock(db, body.hours * 3600 + body.minutes * 60);
    await audit(db, staffOf(req).id, 'clock.advance', 'clock', body);
    return clock;
  });

  app.post('/api/clock/freeze', { config: { permission: 'system' } }, async (req) => {
    const body = parse(z.object({ frozen: z.boolean() }).strict(), req.body, 'body');
    return setClockFrozen(db, body.frozen);
  });

  // --- billing ---
  app.post('/api/billing/run', { config: { permission: 'money' } }, async (req) => {
    parse(z.object({}).strict(), req.body, 'body');
    const result = await runBilling(db);
    await audit(db, staffOf(req).id, 'billing.run', `billing_run:${result.runId}`, { charges: result.chargesCreated, failed: result.itemsFailed });
    return result;
  });

  app.get('/api/billing/runs', { config: { permission: 'read' } }, async (req) => {
    const q = parse(pageQuery, req.query, 'query');
    const [items, total] = await Promise.all([
      db.query(
        `select r.*, coalesce((select json_agg(json_build_object('resource', f.resource, 'resource_id', f.resource_id, 'error', f.error) order by f.id)
                               from billing_failures f where f.run_id = r.id), '[]') as failures
         from billing_runs r order by r.id desc limit $1 offset $2`,
        [q.page_size, (q.page - 1) * q.page_size],
      ),
      db.query<{ n: number }>('select count(*)::int as n from billing_runs'),
    ]);
    return { items: items.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
  });

  // --- prices ---
  app.get('/api/prices', { config: { permission: 'read' } }, async () => {
    const { rows } = await db.query(
      `select p.*, p.effective_from > app_now() as upcoming,
         p.id in (select distinct on (resource) id from prices where effective_from <= app_now() order by resource, effective_from desc) as current
       from prices p order by p.resource, p.effective_from desc`,
    );
    return { items: rows };
  });

  /** A new price applies from the next whole hour; hours already charged keep their price. */
  app.post('/api/prices', { config: { permission: 'money' } }, async (req, reply) => {
    const body = parse(z.object({ resource: z.enum(['server', 'ip']), amount_per_hour: z.number().int().min(0).max(1_000_000) }).strict(), req.body, 'body');
    const staff = staffOf(req);
    const price = await withTx(db, async (tx) => {
      const row = (
        await tx.query(
          `insert into prices (resource, amount_per_hour, effective_from)
           values ($1, $2, date_trunc('hour', app_now(), 'UTC') + interval '1 hour')
           on conflict (resource, effective_from) do update set amount_per_hour = excluded.amount_per_hour, created_at = app_now()
           returning *`,
          [body.resource, body.amount_per_hour],
        )
      ).rows[0];
      await audit(tx, staff.id, 'price.set', `price:${body.resource}`, { ...body, effective_from: row.effective_from });
      return row;
    });
    return reply.code(201).send(price);
  });

  // --- drift ---
  app.post('/api/reconcile', { config: { permission: 'operate' } }, async (req) => {
    parse(z.object({}).strict(), req.body, 'body');
    return reconcile(db, infra);
  });

  app.get('/api/drift-events', { config: { permission: 'read' } }, async (req) => {
    const q = parse(pageQuery, req.query, 'query');
    const [items, total] = await Promise.all([
      db.query(
        `select d.*, s.name as server_name from drift_events d left join servers s on s.id = d.server_id
         order by d.id desc limit $1 offset $2`,
        [q.page_size, (q.page - 1) * q.page_size],
      ),
      db.query<{ n: number }>('select count(*)::int as n from drift_events'),
    ]);
    return { items: items.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
  });

  app.get('/api/audit', { config: { permission: 'read' } }, async (req) => {
    const q = parse(z.object({ subject: z.string().max(100).optional(), page: zs.page, page_size: zs.pageSize }).strict(), req.query, 'query');
    const { rows } = await db.query(
      `select a.*, u.email as staff_email from audit_log a left join staff_users u on u.id = a.staff_id
       where ($1::text is null or a.subject = $1) order by a.id desc limit $2 offset $3`,
      [q.subject ?? null, q.page_size, (q.page - 1) * q.page_size],
    );
    return { items: rows, page: q.page, page_size: q.page_size };
  });

  // --- the fake infrastructure's failure rates, for demos ---
  const chaosBody = z
    .object({
      failRate: z.number().min(0).max(1),
      lieRate: z.number().min(0).max(1),
      provisionMs: z.number().int().min(0).max(120_000),
      latencyMs: z.number().int().min(0).max(30_000),
    })
    .partial()
    .strict();

  app.get('/api/infra/chaos', { config: { permission: 'read' } }, async () => proxyChaos('GET'));
  app.put('/api/infra/chaos', { config: { permission: 'system' } }, async (req) => proxyChaos('PUT', parse(chaosBody, req.body, 'body')));

  async function proxyChaos(method: 'GET' | 'PUT', body?: object) {
    try {
      const res = await fetch(`${infraUrl}/_chaos`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json();
    } catch {
      throw new AppError(502, 'infra_unreachable', 'the infrastructure service did not answer');
    }
  }
}
