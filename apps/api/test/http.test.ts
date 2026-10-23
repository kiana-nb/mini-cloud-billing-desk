// HTTP surface: roles enforced by the server, strict input, retry-safe requests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { installAccessControl } from '../src/http.ts';
import type { InfraClient } from '../src/infra-client.ts';
import { createTestDb, key, makeCustomer, seedStaffTokens } from './helpers.ts';

let db: Db;
let drop: () => Promise<void>;
let app: FastifyInstance;
let tokens: { owner: string; support: string; viewer: string };

const noInfra: InfraClient = {
  create: async () => ({ kind: 'unknown', error: 'offline' }),
  get: async () => ({ kind: 'unknown', error: 'offline' }),
  findByTag: async () => ({ kind: 'unknown', error: 'offline' }),
  list: async () => ({ kind: 'unknown', error: 'offline' }),
  remove: async () => ({ kind: 'unknown', error: 'offline' }),
};

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  tokens = await seedStaffTokens(db);
  app = await buildApp({ db, infra: noInfra, infraUrl: 'http://127.0.0.1:1' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await drop();
});

type Who = keyof typeof tokens | 'nobody';
const call = (who: Who, method: string, url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as 'GET',
    url,
    payload,
    headers: { ...headers, ...(who === 'nobody' ? {} : { authorization: `Bearer ${tokens[who]}` }) },
  });

describe('roles are enforced by the server', () => {
  it('every route declares a permission, or the app refuses to start', async () => {
    const bad = Fastify();
    installAccessControl(bad, db);
    expect(() => bad.get('/api/forgot-permission', async () => ({}))).toThrow(/does not declare a permission/);
    await bad.close();
  });

  it('a viewer cannot change anything', async () => {
    const customerId = await makeCustomer(db);
    const attempts: [string, string, object?][] = [
      ['POST', '/api/customers', { name: 'X', email: 'x@example.test' }],
      ['POST', `/api/customers/${customerId}/topups`, { amount: 100 }],
      ['POST', '/api/servers', { customer_id: customerId, name: 'nope' }],
      ['PUT', `/api/customers/${customerId}/statuses/verified`, {}],
      ['POST', '/api/billing/run', {}],
      ['POST', '/api/clock/advance', { hours: 1 }],
      ['POST', '/api/prices', { resource: 'ip', amount_per_hour: 1 }],
      ['POST', '/api/reconcile', {}],
    ];
    for (const [method, url, body] of attempts) {
      const res = await call('viewer', method, url, body, { 'idempotency-key': key() });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await call('viewer', 'GET', '/api/servers')).statusCode).toBe(200);
  });

  it('support can operate but cannot touch money or the clock', async () => {
    const customerId = await makeCustomer(db);
    expect((await call('support', 'POST', `/api/customers/${customerId}/topups`, { amount: 100 }, { 'idempotency-key': key() })).statusCode).toBe(403);
    expect((await call('support', 'POST', '/api/billing/run', {})).statusCode).toBe(403);
    expect((await call('support', 'POST', '/api/prices', { resource: 'ip', amount_per_hour: 1 })).statusCode).toBe(403);
    expect((await call('support', 'POST', '/api/clock/advance', { hours: 1 })).statusCode).toBe(403);
    const created = await call('support', 'POST', '/api/servers', { customer_id: customerId, name: 'by-support' }, { 'idempotency-key': key() });
    expect(created.statusCode).toBe(201);
  });

  it('no token means 401, a wrong password means 401', async () => {
    expect((await call('nobody', 'GET', '/api/servers')).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com', password: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('strict input', () => {
  it('list endpoints reject parameters they do not understand', async () => {
    for (const url of ['/api/servers?colour=red', '/api/customers?sort=name', '/api/ips?limit=5', '/api/billing/runs?verbose=1']) {
      const res = await call('viewer', 'GET', url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code).toBe('invalid_query');
      expect(res.json().error.details[0].issue).toBe('unknown parameter');
    }
  });

  it('known parameters with bad values are rejected too', async () => {
    expect((await call('viewer', 'GET', '/api/servers?status=sleeping')).statusCode).toBe(400);
    expect((await call('viewer', 'GET', '/api/servers?page_size=1000')).statusCode).toBe(400);
    expect((await call('viewer', 'GET', '/api/servers?customer_id=not-a-uuid')).statusCode).toBe(400);
  });

  it('bodies with unknown fields are rejected', async () => {
    const customerId = await makeCustomer(db);
    const res = await call('owner', 'POST', `/api/customers/${customerId}/topups`, { amount: 100, currency: 'EUR' }, { 'idempotency-key': key() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
  });

  it('search filters combine and are paged', async () => {
    const customerId = await makeCustomer(db);
    for (const name of ['alpha-1', 'alpha-2', 'beta-1']) {
      await call('owner', 'POST', '/api/servers', { customer_id: customerId, name }, { 'idempotency-key': key() });
    }
    const res = await call('viewer', 'GET', `/api/servers?q=alpha&customer_id=${customerId}&status=pending&sort=name&order=asc&page_size=1`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 2, page: 1, page_size: 1, items: [{ name: 'alpha-1' }] });
  });
});

describe('retry-safe requests', () => {
  it('a retried top-up adds the money once', async () => {
    const customerId = await makeCustomer(db, 0);
    const k = key();
    const first = await call('owner', 'POST', `/api/customers/${customerId}/topups`, { amount: 500 }, { 'idempotency-key': k });
    const retries = await Promise.all(
      Array.from({ length: 5 }, () => call('owner', 'POST', `/api/customers/${customerId}/topups`, { amount: 500 }, { 'idempotency-key': k })),
    );
    expect(first.statusCode).toBe(201);
    expect(retries.every((r) => r.statusCode === 200 && r.json().replayed === true)).toBe(true);
    expect((await call('viewer', 'GET', `/api/customers/${customerId}`)).json().balance).toBe(500);

    const reused = await call('owner', 'POST', `/api/customers/${customerId}/topups`, { amount: 900 }, { 'idempotency-key': k });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('idempotency_key_reused');
  });

  it('concurrent retries of one create request make one server', async () => {
    const customerId = await makeCustomer(db);
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call('support', 'POST', '/api/servers', { customer_id: customerId, name: 'once' }, { 'idempotency-key': k })),
    );
    const ids = new Set(results.map((r) => r.json().server.id));
    expect(ids.size).toBe(1);
    const count = await db.query("select count(*)::int as n from servers where customer_id = $1 and name = 'once'", [customerId]);
    expect(count.rows[0].n).toBe(1);
  });

  it('a top-up without an idempotency key is refused', async () => {
    const customerId = await makeCustomer(db);
    const res = await call('owner', 'POST', `/api/customers/${customerId}/topups`, { amount: 100 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });
});

describe('customer rules', () => {
  it('a suspended customer cannot create servers; a customer can hold several statuses', async () => {
    const customerId = await makeCustomer(db);
    await call('support', 'PUT', `/api/customers/${customerId}/statuses/verified`, {});
    await call('support', 'PUT', `/api/customers/${customerId}/statuses/suspended`, { reason: 'test' });
    const detail = (await call('viewer', 'GET', `/api/customers/${customerId}`)).json();
    expect(detail.statuses.sort()).toEqual(['suspended', 'verified']);
    const res = await call('support', 'POST', '/api/servers', { customer_id: customerId, name: 'blocked' }, { 'idempotency-key': key() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('customer_suspended');
  });

  it('a charge can be refunded once, with the exact amount', async () => {
    const customerId = await makeCustomer(db);
    const price = (await db.query("select id from prices where resource = 'ip' limit 1")).rows[0].id;
    const ip = (await db.query('select id from ip_addresses limit 1')).rows[0].id;
    const server = (await db.query("insert into servers (customer_id, name, idempotency_key) values ($1, 'refund-me', $2) returning id", [customerId, key()])).rows[0].id;
    const charge = (
      await db.query(
        "insert into ledger_entries (customer_id, kind, amount, ip_id, holder_server_id, hour_start, price_id) values ($1, 'charge', -20, $2, $3, '2031-01-01T00:00:00Z', $4) returning id",
        [customerId, ip, server, price],
      )
    ).rows[0].id;
    const first = await call('owner', 'POST', `/api/ledger/${charge}/refund`, { reason: 'customer complaint' });
    const second = await call('owner', 'POST', `/api/ledger/${charge}/refund`, {});
    expect(first.statusCode).toBe(201);
    expect(second.json().replayed).toBe(true);
    const refunds = await db.query('select amount from ledger_entries where refund_of = $1', [charge]);
    expect(refunds.rows).toEqual([{ amount: 20 }]);
  });

  it('the ledger cannot be edited, even directly in the database', async () => {
    await expect(db.query("update ledger_entries set amount = amount + 1 where kind = 'topup'")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from ledger_entries where kind = 'topup'")).rejects.toThrow(/append-only/);
  });

  it('the clock only moves forward', async () => {
    const before = (await call('viewer', 'GET', '/api/clock')).json().now;
    const after = (await call('owner', 'POST', '/api/clock/advance', { hours: 2 })).json().now;
    expect(new Date(after).getTime() - new Date(before).getTime()).toBeGreaterThanOrEqual(2 * 3600 * 1000);
    expect((await call('owner', 'POST', '/api/clock/advance', { hours: -1 })).statusCode).toBe(400);
    await expect(db.query("update app_clock set virtual_base = '2000-01-01', real_base = now(), frozen = true")).rejects.toThrow(/forward/);
  });
});
