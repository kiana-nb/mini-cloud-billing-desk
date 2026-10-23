// Hourly billing.
//
// Rule: every UTC clock hour in which a resource was in use is charged once, at the price
// in effect at the start of that hour. "In use" means:
//   - a server: inside one of its server_usage periods (it actually ran);
//   - an IP: assigned to a server while that server ran. If an IP changed hands within an
//     hour, the first holder in that hour pays for it.
//
// Exactly-once does not depend on this code being run once. Each run recomputes every due
// hour from the usage history and inserts the missing charges with ON CONFLICT DO NOTHING
// against the unique indexes ledger_server_hour_once / ledger_ip_hour_once. So:
//   - two runs at the same moment: the second insert of a row waits for the first and skips;
//   - a crash halfway: committed items stay, the next run inserts the rest;
//   - the job was down for hours: the next run finds all missed hours.
// Each resource is billed in its own transaction, so one failing item does not stop the others.
import type { Db } from './db.ts';
import { withTx } from './db.ts';

export type BillingResult = {
  runId: number;
  asOf: string;
  itemsTotal: number;
  itemsFailed: number;
  chargesCreated: number;
  failures: { resource: 'server' | 'ip'; resourceId: string; error: string }[];
};

export type BillingHooks = {
  /** Called after each item is committed. Tests throw from here to simulate a crash. */
  afterItem?: (index: number) => void | Promise<void>;
};

// Hours [lo, hi) of a usage range, with an open range billed up to and including the run's as_of.
// $2 = as_of. "- 1 microsecond" turns the half-open upper bound into an inclusive series end.
const hoursOf = (range: string) => `generate_series(
    date_trunc('hour', lower(${range}), 'UTC'),
    least(coalesce(upper(${range}), 'infinity'), $2::timestamptz + interval '1 microsecond') - interval '1 microsecond',
    interval '1 hour')`;

const billServerSql = `
  insert into ledger_entries (customer_id, kind, amount, server_id, hour_start, price_id, billing_run_id, description)
  select s.customer_id, 'charge', -p.amount_per_hour, s.id, h.hour_start, p.id, $3,
         'Server ' || s.name || ', hour ' || to_char(h.hour_start at time zone 'UTC', 'YYYY-MM-DD HH24:00') || ' UTC'
  from servers s
  join lateral (
    select distinct g.hour_start
    from server_usage u, ${hoursOf('u.during')} as g(hour_start)
    where u.server_id = s.id and lower(u.during) <= $2
  ) h on true
  left join lateral (
    select id, amount_per_hour from prices
    where resource = 'server' and effective_from <= h.hour_start
    order by effective_from desc limit 1
  ) p on true
  where s.id = $1
  on conflict (server_id, hour_start) where server_id is not null do nothing`;

const billIpSql = `
  insert into ledger_entries (customer_id, kind, amount, ip_id, holder_server_id, hour_start, price_id, billing_run_id, description)
  select distinct on (g.hour_start)
         a.customer_id, 'charge', -p.amount_per_hour, a.ip_id, a.server_id, g.hour_start, p.id, $3,
         'IP ' || host(ip.address) || ', hour ' || to_char(g.hour_start at time zone 'UTC', 'YYYY-MM-DD HH24:00') || ' UTC'
  from ip_assignments a
  join ip_addresses ip on ip.id = a.ip_id
  join server_usage u on u.server_id = a.server_id and u.during && a.during
  cross join lateral (select a.during * u.during as r) x
  cross join lateral ${hoursOf('x.r')} as g(hour_start)
  left join lateral (
    select id, amount_per_hour from prices
    where resource = 'ip' and effective_from <= g.hour_start
    order by effective_from desc limit 1
  ) p on true
  where a.ip_id = $1 and lower(x.r) <= $2
  order by g.hour_start, lower(x.r), a.id
  on conflict (ip_id, hour_start) where ip_id is not null do nothing`;

// Candidates: resources that may have an hour not charged yet. Charges of one resource are
// written in one transaction up to as_of, so the latest charged hour is a safe watermark.
const candidatesSql = `
  select 'server' as resource, u.server_id::text as id
  from server_usage u
  where lower(u.during) <= $1
  group by u.server_id
  having bool_or(upper_inf(u.during)) or max(upper(u.during)) > coalesce(
    (select max(hour_start) + interval '1 hour' from ledger_entries l where l.server_id = u.server_id), '-infinity')
  union all
  select 'ip', a.ip_id::text
  from ip_assignments a
  join server_usage u on u.server_id = a.server_id and u.during && a.during
  where lower(a.during * u.during) <= $1
  group by a.ip_id
  having bool_or(upper_inf(a.during * u.during)) or max(upper(a.during * u.during)) > coalesce(
    (select max(hour_start) + interval '1 hour' from ledger_entries l where l.ip_id = a.ip_id), '-infinity')
  order by 1, 2`;

export async function runBilling(db: Db, hooks: BillingHooks = {}): Promise<BillingResult> {
  const run = (
    await db.query<{ id: number; as_of: Date }>('insert into billing_runs (as_of) values (app_now()) returning id, as_of')
  ).rows[0]!;
  const asOf = run.as_of;
  const items = (await db.query<{ resource: 'server' | 'ip'; id: string }>(candidatesSql, [asOf])).rows;

  const result: BillingResult = {
    runId: run.id,
    asOf: asOf.toISOString(),
    itemsTotal: items.length,
    itemsFailed: 0,
    chargesCreated: 0,
    failures: [],
  };

  for (const [index, item] of items.entries()) {
    try {
      const inserted = await withTx(db, async (tx) => {
        const sql = item.resource === 'server' ? billServerSql : billIpSql;
        const id = item.resource === 'server' ? item.id : Number(item.id);
        return (await tx.query(sql, [id, asOf, run.id])).rowCount ?? 0;
      });
      result.chargesCreated += inserted;
    } catch (err) {
      const message = (err as Error).message;
      result.itemsFailed += 1;
      result.failures.push({ resource: item.resource, resourceId: item.id, error: message });
      await db.query('insert into billing_failures (run_id, resource, resource_id, error) values ($1, $2, $3, $4)', [
        run.id,
        item.resource,
        item.id,
        message,
      ]);
    }
    await hooks.afterItem?.(index);
  }

  await db.query(
    'update billing_runs set finished_at = now(), items_total = $2, items_failed = $3, charges_created = $4 where id = $1',
    [run.id, result.itemsTotal, result.itemsFailed, result.chargesCreated],
  );
  return result;
}
