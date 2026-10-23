// Background work against the unreliable infrastructure.
//
// Principle: an error from the infrastructure means "unknown outcome", never "it did not
// happen". Before acting again we look at what really exists. Our server id is sent as the
// infrastructure tag, so a server we asked for can always be found again.
//
// Each step claims rows with a short lease (FOR UPDATE SKIP LOCKED), so several workers or
// API instances never handle the same server at the same time.
import type { Db } from './db.ts';
import { withTx, pgCode, PgCode } from './db.ts';
import type { InfraClient, InfraServer } from './infra-client.ts';
import { closeAssignments, closeOpenUsage, type ServerRow } from './servers.ts';

export const MAX_CREATE_ATTEMPTS = 8;
const LEASE = '30 seconds';

type Claimed = ServerRow & { attempts: number };

async function claim(db: Db, status: ServerRow['status'], limit: number): Promise<Claimed[]> {
  const { rows } = await db.query<Claimed>(
    `update servers set lease_until = now() + $3::interval
     where id in (
       select id from servers
       where status = $1 and next_attempt_at <= now() and (lease_until is null or lease_until < now())
       order by next_attempt_at limit $2
       for update skip locked)
     returning *`,
    [status, limit, LEASE],
  );
  return rows;
}

/** Releases the lease and schedules the next try with exponential backoff (1s .. 60s). */
async function retryLater(db: Db, id: string, error: string) {
  await db.query(
    `update servers set attempts = attempts + 1, last_error = $2, lease_until = null,
       next_attempt_at = now() + least(power(2, attempts), 60) * interval '1 second'
     where id = $1`,
    [id, error],
  );
}

async function drift(db: Db, kind: string, serverId: string | null, infraId: string | null, detail: string) {
  await db.query('insert into drift_events (kind, server_id, infra_id, detail) values ($1, $2, $3, $4)', [kind, serverId, infraId, detail]);
}

/**
 * Links an infrastructure server to our record. Returns false if the record already tracks
 * another infrastructure server; the caller then deletes the extra one.
 */
async function adopt(db: Db, serverId: string, infra: InfraServer): Promise<boolean> {
  try {
    const { rowCount } = await db.query(
      `update servers set infra_id = $2, infra_linked_at = now(),
         status = case when status = 'pending' then 'provisioning'::server_status else status end,
         attempts = 0, next_attempt_at = now(), lease_until = null, last_error = null
       where id = $1 and (infra_id is null or infra_id = $2)`,
      [serverId, infra.id],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    if (pgCode(err) === PgCode.uniqueViolation) return false; // already tracked by another record (unique infra_id)
    throw err;
  }
}

/** pending -> provisioning: make sure exactly one infrastructure server exists for the record. */
export async function provisionPending(db: Db, infra: InfraClient, limit = 10): Promise<void> {
  for (const server of await claim(db, 'pending', limit)) {
    // 1. Did an earlier attempt (that reported an error) actually create it?
    const found = await infra.findByTag(server.id);
    if (found.kind !== 'ok') {
      await retryLater(db, server.id, `lookup failed: ${found.kind === 'unknown' ? found.error : 'not found'}`);
      continue;
    }
    if (found.value.length > 0) {
      const oldest = [...found.value].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
      if (await adopt(db, server.id, oldest)) await drift(db, 'adopted', server.id, oldest.id, 'found by tag after an unclear create');
      continue; // any extra servers with this tag are removed by the reconciler
    }
    if (server.attempts >= MAX_CREATE_ATTEMPTS) {
      await failProvisioning(db, server.id, 'gave up creating the server');
      continue;
    }
    // 2. Nothing exists: ask for it.
    const created = await infra.create(server.id);
    if (created.kind === 'ok') {
      if (!(await adopt(db, server.id, created.value))) await infra.remove(created.value.id);
      continue;
    }
    // 3. Unknown outcome: do not create again blindly. The next attempt starts with a lookup.
    await retryLater(db, server.id, `create failed: ${created.kind === 'unknown' ? created.error : 'not found'}`);
  }
}

async function failProvisioning(db: Db, serverId: string, reason: string) {
  await withTx(db, async (tx) => {
    await tx.query("update servers set status = 'failed', last_error = $2, lease_until = null where id = $1 and status = 'pending'", [serverId, reason]);
    await closeAssignments(tx, { serverId });
  });
}

/** provisioning -> running once the infrastructure says it is ready. Billing starts here. */
export async function pollProvisioning(db: Db, infra: InfraClient, limit = 20): Promise<void> {
  for (const server of await claim(db, 'provisioning', limit)) {
    const state = await infra.get(server.infra_id!);
    if (state.kind === 'notFound') {
      // the infrastructure lost it: forget the link and create a new one
      await db.query(
        "update servers set status = 'pending', infra_id = null, infra_linked_at = null, lease_until = null, next_attempt_at = now() where id = $1 and status = 'provisioning'",
        [server.id],
      );
      await drift(db, 'lost_while_provisioning', server.id, server.infra_id, 'infrastructure no longer knows the server');
      continue;
    }
    if (state.kind === 'ok' && state.value.status === 'running') {
      await withTx(db, async (tx) => {
        const updated = await tx.query(
          "update servers set status = 'running', running_at = app_now(), lease_until = null, last_error = null where id = $1 and status = 'provisioning'",
          [server.id],
        );
        if (updated.rowCount) await tx.query('insert into server_usage (server_id, during) values ($1, tstzrange(app_now(), null))', [server.id]);
      });
      continue;
    }
    await db.query("update servers set lease_until = null, next_attempt_at = now() + interval '1 second' where id = $1", [server.id]);
  }
}

/** terminating -> terminated once the infrastructure server is really gone. */
export async function processTerminations(db: Db, infra: InfraClient, limit = 20): Promise<void> {
  for (const server of await claim(db, 'terminating', limit)) {
    let ids: string[];
    if (server.infra_id) {
      ids = [server.infra_id];
    } else {
      // terminated before it was linked: a create may still have succeeded
      const found = await infra.findByTag(server.id);
      if (found.kind !== 'ok') {
        await retryLater(db, server.id, 'lookup failed');
        continue;
      }
      ids = found.value.map((s) => s.id);
    }
    let allGone = true;
    for (const id of ids) {
      const removed = await infra.remove(id);
      if (removed.kind === 'unknown') {
        // the delete may have happened anyway; check instead of trusting the error
        const check = await infra.get(id);
        if (check.kind !== 'notFound') allGone = false;
      }
    }
    if (allGone) {
      await db.query(
        "update servers set status = 'terminated', terminated_at = app_now(), lease_until = null, last_error = null where id = $1 and status = 'terminating'",
        [server.id],
      );
    } else {
      await retryLater(db, server.id, 'delete not confirmed');
    }
  }
}

export type ReconcileReport = { skipped: boolean; actions: { kind: string; serverId: string | null; infraId: string | null }[] };

/**
 * Compares the infrastructure with our records and repairs drift:
 *   - an infrastructure server nobody tracks (unknown tag, duplicate, or belonging to a
 *     failed/terminated record) is deleted;
 *   - a pending record whose server exists is linked to it;
 *   - a running record whose server is gone is closed (billing stops at detection time).
 * If the listing fails we do nothing: acting on partial data would create drift.
 */
export async function reconcile(db: Db, infra: InfraClient): Promise<ReconcileReport> {
  const report: ReconcileReport = { skipped: false, actions: [] };
  const startedAt = new Date();
  const listed = await infra.list();
  if (listed.kind !== 'ok') return { skipped: true, actions: [] };

  const rows = (await db.query<ServerRow & { infra_linked_at: Date | null }>('select * from servers')).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const record = async (kind: string, serverId: string | null, infraId: string | null, detail: string) => {
    report.actions.push({ kind, serverId, infraId });
    await drift(db, kind, serverId, infraId, detail);
  };
  const removeOnInfra = async (s: InfraServer, kind: string, serverId: string | null, detail: string) => {
    const removed = await infra.remove(s.id);
    if (removed.kind !== 'unknown') await record(kind, serverId, s.id, detail);
  };

  for (const s of listed.value) {
    const row = s.tag ? byId.get(s.tag) : undefined;
    if (!row) {
      await removeOnInfra(s, 'orphan_deleted', null, 'no record has this tag');
    } else if (row.infra_id === s.id) {
      if (row.status === 'terminated' || row.status === 'failed') await removeOnInfra(s, 'zombie_deleted', row.id, `record is ${row.status}`);
    } else if (row.infra_id === null && (row.status === 'pending' || row.status === 'provisioning')) {
      if (await adopt(db, row.id, s)) await record('adopted', row.id, s.id, 'created although the infrastructure reported an error');
    } else if (row.infra_id === null && (row.status === 'terminated' || row.status === 'failed')) {
      await removeOnInfra(s, 'late_create_deleted', row.id, `created after the record became ${row.status}`);
    } else if (row.infra_id !== null) {
      await removeOnInfra(s, 'duplicate_deleted', row.id, `record already tracks ${row.infra_id}`);
    }
  }

  const listedIds = new Set(listed.value.map((s) => s.id));
  for (const row of rows) {
    if (row.status !== 'running' || !row.infra_id || listedIds.has(row.infra_id)) continue;
    if (!row.infra_linked_at || row.infra_linked_at >= startedAt) continue; // linked after the listing was taken
    const check = await infra.get(row.infra_id);
    if (check.kind !== 'notFound') continue; // only act on a confirmed absence
    await withTx(db, async (tx) => {
      const locked = await tx.query<ServerRow>("select * from servers where id = $1 and status = 'running' for update", [row.id]);
      if (!locked.rowCount) return;
      await closeOpenUsage(tx, row.id);
      await closeAssignments(tx, { serverId: row.id });
      await tx.query(
        "update servers set status = 'terminated', terminated_at = app_now(), terminate_requested_at = app_now(), last_error = 'lost by the infrastructure' where id = $1",
        [row.id],
      );
    });
    await record('lost_while_running', row.id, row.infra_id, 'server vanished from the infrastructure; billing stopped');
  }
  return report;
}

/** Runs every job on a timer until stop() is called. */
export function startWorkers(
  jobs: { name: string; everyMs: number; run: () => Promise<unknown> }[],
  log: (msg: string, err?: unknown) => void,
) {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  for (const job of jobs) {
    const tick = async () => {
      if (stopped) return;
      try {
        await job.run();
      } catch (err) {
        log(`job ${job.name} failed`, err);
      }
      if (!stopped) timers.push(setTimeout(tick, job.everyMs));
    };
    timers.push(setTimeout(tick, 0));
  }
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
  };
}
