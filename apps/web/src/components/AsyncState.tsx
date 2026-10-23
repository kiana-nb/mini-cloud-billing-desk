import type { ReactNode } from 'react';
import type { RequestState } from '../lib/useLatestRequest';

type Props<T> = {
  state: RequestState<T> & { reload: () => void };
  /** Decides whether loaded data counts as empty (for lists: no items). */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  what: string;
  children: (data: T) => ReactNode;
};

/**
 * One place that makes loading, empty and failed look different:
 *  - loading (first time): a skeleton, never "no results";
 *  - loading again: the previous data, dimmed, with an "Updating" note;
 *  - empty: an explicit message, only after a successful answer;
 *  - failed: the error and a Retry button, never an empty list.
 */
export function AsyncState<T>({ state, isEmpty, empty, what, children }: Props<T>) {
  if (state.status === 'error') {
    return (
      <div className="state state-error" role="alert">
        <strong>Could not load {what}.</strong>
        <span>{state.error.message}</span>
        <button type="button" onClick={state.reload}>
          Retry
        </button>
      </div>
    );
  }
  if (state.data === undefined) {
    return (
      <div className="state state-loading" aria-busy="true" aria-live="polite">
        <span className="spinner" aria-hidden="true" /> Loading {what}…
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton short" />
      </div>
    );
  }
  const refreshing = state.status === 'loading';
  if (!refreshing && isEmpty?.(state.data)) {
    return <div className="state state-empty">{empty ?? `No ${what} yet.`}</div>;
  }
  return (
    <div className={refreshing ? 'refreshing' : undefined} aria-busy={refreshing}>
      {refreshing && <div className="updating-note">Updating…</div>}
      {children(state.data)}
    </div>
  );
}
