// Optional challenge "the infrastructure lies": never lose track of a server, never track one
// twice, and repair drift. Runs against the real fake-infrastructure app with scripted chaos.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildInfraApp } from '../../infra/src/app.ts';
import type { Db } from '../src/db.ts';
import { httpInfraClient, type InfraClient } from '../src/infra-client.ts';
import { createServer, terminateServer } from '../src/servers.ts';
import { pollProvisioning, processTerminations, provisionPending, reconcile } from '../src/workers.ts';
import { createTestDb, key, makeCustomer, setClock } from './helpers.ts';

let db: Db;
let drop: () => Promise<void>;
let infraApp: FastifyInstance;
let infra: InfraClient;
let baseUrl: string;
/** Scripted random draws for the infrastructure; when empty it behaves (0.99 = no failure, no lie). */
let draws: number[] = [];

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  await setClock(db, '2030-05-01T10:00:00Z');
  infraApp = buildInfraApp({ chaos: { failRate: 0.5, lieRate: 0.5, provisionMs: 0, latencyMs: 0 }, random: () => draws.shift() ?? 0.99 });
  baseUrl = await infraApp.listen({ port: 0, host: '127.0.0.1' });
  infra = httpInfraClient(baseUrl);
});
afterAll(async () => {
  await infraApp.close();
  await drop();
});
beforeEach(async () => {
  draws = [];
  // tests in this file must not see servers of earlier tests
  await db.query("update servers set status = 'terminated' where status <> 'terminated'");
  const leftovers = (await (await fetch(`${baseUrl}/servers`)).json()) as { id: string }[];
  for (const s of leftovers) await fetch(`${baseUrl}/servers/${s.id}`, { method: 'DELETE' });
});

const infraServers = async () => (await (await fetch(`${baseUrl}/servers`)).json()) as { id: string; tag: string }[];
const row = async (id: string) => (await db.query('select * from servers where id = $1', [id])).rows[0];
/** Lets every retry that is waiting for its backoff run now. */
const ready = () => db.query('update servers set next_attempt_at = now(), lease_until = null');
const post = (tag: string) => fetch(`${baseUrl}/servers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag }) });

async function newServer() {
  const customerId = await makeCustomer(db);
  return (await createServer(db, { customerId, name: `w-${key().slice(0, 8)}`, idempotencyKey: key(), staffId: null })).server.id;
}

describe('the infrastructure lies (optional challenge)', () => {
  it('create reports an error but happened: the server is adopted, not created twice', async () => {
    const id = await newServer();
    draws = [0.99, 0.99, 0.1]; // lookup ok; create passes the fail check, then lies
    await provisionPending(db, infra);
    expect((await row(id)).status).toBe('pending'); // outcome unknown, nothing linked yet
    await ready();
    await provisionPending(db, infra); // the next attempt looks up by tag first
    expect((await row(id)).status).toBe('provisioning');
    expect((await infraServers()).filter((s) => s.tag === id)).toHaveLength(1);
    await pollProvisioning(db, infra);
    expect((await row(id)).status).toBe('running');
  });

  it('create really failed: it is created on a later attempt, once', async () => {
    const id = await newServer();
    draws = [0.99, 0.1]; // lookup ok, create fails without effect
    await provisionPending(db, infra);
    await ready();
    await provisionPending(db, infra);
    expect((await infraServers()).filter((s) => s.tag === id)).toHaveLength(1);
    expect((await row(id)).infra_id).not.toBeNull();
  });

  it('a failing lookup never leads to a blind create', async () => {
    const id = await newServer();
    draws = [0.1]; // the lookup itself fails
    await provisionPending(db, infra);
    expect(await infraServers()).toHaveLength(0);
    expect((await row(id)).last_error).toMatch(/lookup failed/);
  });

  it('delete reports an error but happened: the server is still marked terminated', async () => {
    const id = await newServer();
    await provisionPending(db, infra);
    await pollProvisioning(db, infra);
    await terminateServer(db, { serverId: id, staffId: null, reason: '' });
    draws = [0.99, 0.1]; // delete passes the fail check, then lies; the follow-up GET says 404
    await processTerminations(db, infra);
    expect((await row(id)).status).toBe('terminated');
    expect((await infraServers()).filter((s) => s.tag === id)).toHaveLength(0);
  });

  it('reconciler removes orphans and duplicates, and adopts a server we lost track of', async () => {
    const tracked = await newServer();
    await provisionPending(db, infra);
    const before = await row(tracked);
    await post('not-ours'); // an orphan nobody asked for
    await post(tracked); // a duplicate with our tag
    const lost = await newServer();
    await post(lost); // created, but we never heard back

    const report = await reconcile(db, infra);
    expect(report.actions.map((a) => a.kind).sort()).toEqual(['adopted', 'duplicate_deleted', 'orphan_deleted']);
    expect((await row(tracked)).infra_id).toBe(before.infra_id);
    expect((await row(lost)).status).toBe('provisioning');
    const left = await infraServers();
    expect(left.filter((s) => s.tag === tracked)).toHaveLength(1);
    expect(left.filter((s) => s.tag === 'not-ours')).toHaveLength(0);
  });

  it('reconciler deletes a server created after its record was given up', async () => {
    const id = await newServer();
    await db.query("update servers set status = 'failed' where id = $1", [id]);
    await post(id);
    const report = await reconcile(db, infra);
    expect(report.actions).toContainEqual(expect.objectContaining({ kind: 'late_create_deleted', serverId: id }));
    expect(await infraServers()).toHaveLength(0);
  });

  it('reconciler stops billing a running server that vanished from the infrastructure', async () => {
    const id = await newServer();
    await provisionPending(db, infra);
    await pollProvisioning(db, infra);
    await db.query("update servers set infra_linked_at = now() - interval '1 minute' where id = $1", [id]);
    await fetch(`${baseUrl}/servers/${(await row(id)).infra_id}`, { method: 'DELETE' });
    const report = await reconcile(db, infra);
    expect(report.actions).toContainEqual(expect.objectContaining({ kind: 'lost_while_running', serverId: id }));
    expect((await row(id)).status).toBe('terminated');
    const open = await db.query('select 1 from server_usage where server_id = $1 and upper_inf(during)', [id]);
    expect(open.rowCount).toBe(0);
  });

  it('if the listing fails, the reconciler does nothing', async () => {
    await post('not-ours');
    draws = [0.1];
    expect(await reconcile(db, infra)).toEqual({ skipped: true, actions: [] });
    expect(await infraServers()).toHaveLength(1);
  });

  it('under random chaos every server ends up tracked exactly once, and all are cleaned up', async () => {
    // seeded pseudo-random chaos: 30% failures and 30% lies on every call
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const chaosApp = buildInfraApp({ chaos: { failRate: 0.3, lieRate: 0.3, provisionMs: 0, latencyMs: 0 }, random: rand });
    const url = await chaosApp.listen({ port: 0, host: '127.0.0.1' });
    const chaosInfra = httpInfraClient(url);
    /** Reads the truth: chaos off for the test's own look, back on afterwards. */
    const truth = async () => {
      await fetch(`${url}/_chaos`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ failRate: 0, lieRate: 0 }) });
      const list = (await (await fetch(`${url}/servers`)).json()) as { id: string }[];
      await fetch(`${url}/_chaos`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ failRate: 0.3, lieRate: 0.3 }) });
      return list;
    };
    try {
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push(await newServer());
      for (let i = 0; i < 40; i++) {
        await ready();
        await provisionPending(db, chaosInfra);
        await pollProvisioning(db, chaosInfra);
        await reconcile(db, chaosInfra);
      }
      const rows = (await db.query('select id, status, infra_id from servers where id = any($1)', [ids])).rows;
      expect(rows.map((r) => r.status)).toEqual(ids.map(() => 'running'));
      const listed = await truth();
      // every record points at a distinct live server, and nothing else exists
      expect(listed.map((s) => s.id).sort()).toEqual(rows.map((r) => r.infra_id).sort());

      for (const id of ids) await terminateServer(db, { serverId: id, staffId: null, reason: '' });
      for (let i = 0; i < 40; i++) {
        await ready();
        await processTerminations(db, chaosInfra);
        await reconcile(db, chaosInfra);
      }
      const after = (await db.query('select status from servers where id = any($1)', [ids])).rows;
      expect(after.map((r) => r.status)).toEqual(ids.map(() => 'terminated'));
      expect(await truth()).toEqual([]);
    } finally {
      await chaosApp.close();
    }
  });
});
