import { PgCode, pgCode } from './db.ts';

/** An error with a stable code the frontend can map to a message. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

/** Translates database rule violations into HTTP answers; the database is the last line of defence. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  switch (pgCode(err)) {
    case PgCode.exclusionViolation:
      return new AppError(409, 'overlap', 'the change overlaps an existing period (for example, the IP is already held)');
    case PgCode.uniqueViolation:
      return new AppError(409, 'duplicate', 'the change conflicts with an existing record');
    case PgCode.foreignKeyViolation:
      return new AppError(404, 'reference_not_found', 'a referenced record does not exist');
    case PgCode.checkViolation:
      return new AppError(400, 'invalid', 'the values break a rule of the data model');
    case PgCode.raiseException:
      return new AppError(409, 'rule_violation', message);
    case PgCode.serializationFailure:
    case PgCode.deadlock:
      return new AppError(409, 'concurrent_change', 'a concurrent change got in the way, please retry');
    default:
      return new AppError(500, 'internal', 'internal error');
  }
}
