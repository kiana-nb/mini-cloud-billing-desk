// Demo data. Runs only on an empty database, so restarting the stack keeps your changes.
import type { Db } from './db.ts';
import { withTx } from './db.ts';
import { hashPassword } from './auth.ts';

export const demoStaff = [
  { email: 'owner@example.com', name: 'Olivia Owner', role: 'owner', password: 'owner-pass' },
  { email: 'support@example.com', name: 'Sam Support', role: 'support', password: 'support-pass' },
  { email: 'viewer@example.com', name: 'Victor Viewer', role: 'viewer', password: 'viewer-pass' },
] as const;

export async function seed(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>('select count(*)::int as n from staff_users');
  if (rows[0]!.n > 0) return false;
  await withTx(db, async (tx) => {
    for (const s of demoStaff) {
      await tx.query('insert into staff_users (email, name, role, password_hash) values ($1, $2, $3, $4)', [s.email, s.name, s.role, hashPassword(s.password)]);
    }
    const customers = [
      { name: 'Acme Robotics', email: 'billing@acme.example', topup: 50_000, statuses: ['verified'] },
      { name: 'Blue Fern Studio', email: 'hello@bluefern.example', topup: 8_000, statuses: ['verified'] },
      { name: 'Cobalt Labs', email: 'ops@cobalt.example', topup: 2_000, statuses: [] },
      { name: 'Delta Freight', email: 'it@delta.example', topup: 500, statuses: ['verified', 'suspended'] },
    ];
    for (const c of customers) {
      const id = (await tx.query<{ id: string }>('insert into customers (name, email) values ($1, $2) returning id', [c.name, c.email])).rows[0]!.id;
      await tx.query("insert into ledger_entries (customer_id, kind, amount, idempotency_key, description) values ($1, 'topup', $2, 'seed', 'Opening balance')", [id, c.topup]);
      for (const status of c.statuses) {
        await tx.query('insert into customer_statuses (customer_id, status, reason) values ($1, $2, $3)', [id, status, 'demo data']);
      }
    }
    // a few servers go through the normal pipeline: the workers provision them in the background
    const servers: [string, string][] = [
      ['billing@acme.example', 'web-1'],
      ['billing@acme.example', 'web-2'],
      ['billing@acme.example', 'db-primary'],
      ['hello@bluefern.example', 'render-node'],
      ['ops@cobalt.example', 'ci-runner'],
    ];
    for (const [email, name] of servers) {
      const server = (
        await tx.query<{ id: string; customer_id: string }>(
          "insert into servers (customer_id, name, idempotency_key) select id, $2, 'seed-' || $2 from customers where email = $1 returning id, customer_id",
          [email, name],
        )
      ).rows[0]!;
      await tx.query(
        `insert into ip_assignments (ip_id, server_id, customer_id, during)
         select ip.id, $1, $2, tstzrange(app_now(), null) from ip_addresses ip
         where not exists (select 1 from ip_assignments a where a.ip_id = ip.id and upper_inf(a.during))
         order by ip.id limit 1`,
        [server.id, server.customer_id],
      );
    }
  });
  return true;
}
