import { useCallback, useEffect, useRef, useState } from 'react';

export type RequestState<T> =
  | { status: 'loading'; data: T | undefined; error: undefined }
  | { status: 'success'; data: T; error: undefined }
  | { status: 'error'; data: T | undefined; error: Error };

/**
 * Loads data for `key` and guarantees that only the answer to the LATEST request is shown.
 *
 * Two guards, because one is not enough:
 *  - the previous request is aborted when the key changes (saves work, but a server or a
 *    mock may ignore the abort, and a response can already be in flight);
 *  - every request gets a sequence number, and a response is applied only if its number is
 *    still the newest. A slow answer for an older search can therefore never overwrite the
 *    results of a newer one.
 *
 * While a new request runs, the previous data stays available so the UI does not flash.
 */
export function useLatestRequest<T>(key: string, load: (signal: AbortSignal) => Promise<T>): RequestState<T> & { reload: () => void } {
  const [state, setState] = useState<RequestState<T>>({ status: 'loading', data: undefined, error: undefined });
  const latest = useRef(0);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const id = ++latest.current;
    const controller = new AbortController();
    setState((s) => ({ status: 'loading', data: s.data, error: undefined }));
    loadRef.current(controller.signal).then(
      (data) => {
        if (id === latest.current) setState({ status: 'success', data, error: undefined });
      },
      (error: Error) => {
        if (id === latest.current && error?.name !== 'AbortError') setState((s) => ({ status: 'error', data: s.data, error }));
      },
    );
    return () => controller.abort();
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
