import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';

/** Money is an integer amount of credits; never formatted through floating point division. */
export function Money({ amount }: { amount: number }) {
  return <span className={amount < 0 ? 'money negative' : 'money'}>{amount.toLocaleString('en-US')} cr</span>;
}

export function When({ at }: { at: string | null | undefined }) {
  if (!at) return <span className="muted">—</span>;
  const d = new Date(at);
  return <time dateTime={at} title={d.toISOString()}>{d.toISOString().slice(0, 16).replace('T', ' ')} UTC</time>;
}

export function Badge({ value }: { value: string }) {
  return <span className={`badge badge-${value}`}>{value.replace('_', ' ')}</span>;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label="Pagination">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {pages} · {total} total
      </span>
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

const newKey = () => crypto.randomUUID();

/**
 * Runs a mutation with an idempotency key that stays the same until the action succeeds,
 * so pressing the button again after a timeout or error retries the SAME request instead
 * of creating a second top-up or server.
 */
export function useAction<A extends unknown[], R>(fn: (key: string, ...args: A) => Promise<R>) {
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (...args: A): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn(key, ...args);
      setKey(newKey());
      return result;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  /** Starts a fresh request, e.g. when the user changes the form after an error. */
  const reset = () => {
    setKey(newKey());
    setError(null);
  };
  return { run, busy, error, reset };
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <p className="error-note" role="alert">
      {error}
    </p>
  ) : null;
}
