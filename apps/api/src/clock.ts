import type { Db, Tx } from './db.ts';

export type ClockState = { now: string; frozen: boolean };

export async function readClock(db: Db | Tx): Promise<ClockState> {
  const { rows } = await db.query<{ now: Date; frozen: boolean }>('select app_now() as now, frozen from app_clock');
  return { now: rows[0]!.now.toISOString(), frozen: rows[0]!.frozen };
}

/** Moves the application clock forward. The database refuses to move it back. */
export async function advanceClock(db: Db | Tx, seconds: number): Promise<ClockState> {
  await db.query('update app_clock set virtual_base = app_now() + make_interval(secs => $1), real_base = now()', [seconds]);
  return readClock(db);
}

/** Freezes the clock at its current reading, or lets it tick with real time again. */
export async function setClockFrozen(db: Db | Tx, frozen: boolean): Promise<ClockState> {
  await db.query('update app_clock set virtual_base = app_now(), real_base = now(), frozen = $1', [frozen]);
  return readClock(db);
}
