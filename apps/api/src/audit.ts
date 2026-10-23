import type { Db, Tx } from './db.ts';

export async function audit(db: Db | Tx, staffId: string | null, action: string, subject: string, detail: object = {}) {
  await db.query('insert into audit_log (staff_id, action, subject, detail) values ($1, $2, $3, $4)', [
    staffId,
    action,
    subject,
    JSON.stringify(detail),
  ]);
}
