import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';

export type Role = 'owner' | 'support' | 'viewer';

/**
 * What each role may do. Routes declare one permission and the server checks it;
 * the UI only hides buttons for convenience.
 *   read    - see everything
 *   operate - change customers, servers and IPs (no money)
 *   money   - top-ups, refunds, prices, billing runs
 *   system  - the test clock and the fake infrastructure's failure rates
 */
export type Permission = 'read' | 'operate' | 'money' | 'system';

export const rolePermissions: Record<Role, readonly Permission[]> = {
  owner: ['read', 'operate', 'money', 'system'],
  support: ['read', 'operate'],
  viewer: ['read'],
};

export type Staff = { id: string; email: string; name: string; role: Role };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function login(db: Db, email: string, password: string): Promise<{ token: string; staff: Staff } | null> {
  const { rows } = await db.query('select id, email, name, role, password_hash from staff_users where email = $1', [email.toLowerCase()]);
  const row = rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  const token = randomBytes(32).toString('base64url');
  await db.query("insert into staff_sessions (token_hash, staff_id, expires_at) values ($1, $2, now() + interval '12 hours')", [
    sha256(token),
    row.id,
  ]);
  return { token, staff: { id: row.id, email: row.email, name: row.name, role: row.role } };
}

export async function staffForToken(db: Db, token: string): Promise<Staff | null> {
  const { rows } = await db.query<Staff>(
    `select u.id, u.email, u.name, u.role from staff_sessions s join staff_users u on u.id = s.staff_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query('delete from staff_sessions where token_hash = $1', [sha256(token)]);
}
