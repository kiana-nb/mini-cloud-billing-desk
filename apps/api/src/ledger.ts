// Money movements. The ledger is append-only (enforced by a trigger); a balance is always
// the sum of a customer's entries.
import type { Db, Tx } from './db.ts';
import { withTx } from './db.ts';
import { AppError, notFound } from './errors.ts';
import { audit } from './audit.ts';

export type LedgerEntry = {
  id: number;
  customer_id: string;
  kind: 'topup' | 'charge' | 'refund';
  amount: number;
  created_at: Date;
  description: string;
  refund_of: number | null;
  server_id: string | null;
  ip_id: number | null;
  holder_server_id: string | null;
  hour_start: Date | null;
};

export async function balanceOf(db: Db | Tx, customerId: string): Promise<number> {
  const { rows } = await db.query<{ balance: number }>(
    'select coalesce(sum(amount), 0)::bigint as balance from ledger_entries where customer_id = $1',
    [customerId],
  );
  return rows[0]!.balance;
}

/**
 * Adds money. Safe to retry: the client sends an idempotency key and a retry with the same
 * key returns the first result instead of adding the money again (unique index
 * ledger_topup_once). Reusing a key for a different amount is refused.
 */
export async function topUp(
  db: Db,
  input: { customerId: string; amount: number; idempotencyKey: string; description: string; staffId: string | null },
): Promise<{ entry: LedgerEntry; replayed: boolean }> {
  return withTx(db, async (tx) => {
    const exists = await tx.query('select 1 from customers where id = $1', [input.customerId]);
    if (exists.rowCount === 0) throw notFound('customer');
    const inserted = await tx.query<LedgerEntry>(
      `insert into ledger_entries (customer_id, kind, amount, idempotency_key, description)
       values ($1, 'topup', $2, $3, $4)
       on conflict (customer_id, idempotency_key) where kind = 'topup' do nothing
       returning *`,
      [input.customerId, input.amount, input.idempotencyKey, input.description],
    );
    if (inserted.rows[0]) {
      await audit(tx, input.staffId, 'topup', `customer:${input.customerId}`, { amount: input.amount, entry: inserted.rows[0].id });
      return { entry: inserted.rows[0], replayed: false };
    }
    const existing = (
      await tx.query<LedgerEntry>(
        "select * from ledger_entries where customer_id = $1 and kind = 'topup' and idempotency_key = $2",
        [input.customerId, input.idempotencyKey],
      )
    ).rows[0]!;
    if (existing.amount !== input.amount) {
      throw new AppError(409, 'idempotency_key_reused', 'this idempotency key was already used for a different amount');
    }
    return { entry: existing, replayed: true };
  });
}

/** Returns one charge in full. A charge can be refunded once (unique index ledger_refund_once). */
export async function refundCharge(
  db: Db,
  input: { entryId: number; staffId: string | null; reason: string },
): Promise<{ entry: LedgerEntry; replayed: boolean }> {
  return withTx(db, async (tx) => {
    const charge = (await tx.query<LedgerEntry>('select * from ledger_entries where id = $1', [input.entryId])).rows[0];
    if (!charge) throw notFound('ledger entry');
    if (charge.kind !== 'charge') throw new AppError(409, 'not_a_charge', 'only charges can be refunded');
    const inserted = await tx.query<LedgerEntry>(
      `insert into ledger_entries (customer_id, kind, amount, refund_of, description)
       values ($1, 'refund', $2, $3, $4)
       on conflict (refund_of) where refund_of is not null do nothing
       returning *`,
      [charge.customer_id, -charge.amount, charge.id, `Refund of #${charge.id}${input.reason ? `: ${input.reason}` : ''}`],
    );
    if (inserted.rows[0]) {
      await audit(tx, input.staffId, 'refund', `customer:${charge.customer_id}`, { charge: charge.id, reason: input.reason });
      return { entry: inserted.rows[0], replayed: false };
    }
    const existing = (await tx.query<LedgerEntry>('select * from ledger_entries where refund_of = $1', [charge.id])).rows[0]!;
    return { entry: existing, replayed: true };
  });
}
