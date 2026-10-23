// Challenge 3 (required): a slow response for an older search must never replace the
// results of a newer one.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { useLatestRequest } from '../src/lib/useLatestRequest';
import { ServerList } from '../src/pages/ServerList';

/** A promise we resolve by hand, to control the order in which answers arrive. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('useLatestRequest', () => {
  it('ignores an older answer that arrives after a newer one, even if the abort is ignored', async () => {
    const answers: Record<string, ReturnType<typeof deferred<string>>> = { a: deferred(), ab: deferred() };
    // the loader ignores the abort signal on purpose, like a server that answers anyway
    const { result, rerender } = renderHook(({ key }) => useLatestRequest(key, () => answers[key]!.promise), { initialProps: { key: 'a' } });
    rerender({ key: 'ab' });

    await act(async () => answers.ab!.resolve('results for ab'));
    expect(result.current).toMatchObject({ status: 'success', data: 'results for ab' });

    await act(async () => answers.a!.resolve('results for a')); // late, stale
    expect(result.current).toMatchObject({ status: 'success', data: 'results for ab' });
  });

  it('a late failure of an older request does not show an error over newer results', async () => {
    const answers: Record<string, ReturnType<typeof deferred<string>>> = { a: deferred(), ab: deferred() };
    const { result, rerender } = renderHook(({ key }) => useLatestRequest(key, () => answers[key]!.promise), { initialProps: { key: 'a' } });
    rerender({ key: 'ab' });
    await act(async () => answers.ab!.resolve('fresh'));
    await act(async () => answers.a!.reject(new Error('timeout')));
    expect(result.current).toMatchObject({ status: 'success', data: 'fresh' });
  });

  it('aborts the previous request when the key changes', () => {
    const signals: AbortSignal[] = [];
    const { rerender } = renderHook(({ key }) => useLatestRequest(key, (signal) => (signals.push(signal), new Promise(() => {}))), {
      initialProps: { key: 'a' },
    });
    rerender({ key: 'ab' });
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });
});

// --- the real server list, with fetch answering in the wrong order ---

const page = (names: string[]) => ({
  items: names.map((name, i) => ({
    id: `00000000-0000-0000-0000-00000000000${i}`,
    name,
    status: 'running',
    created_at: '2030-01-01T00:00:00Z',
    customer_id: 'c1',
    customer_name: 'Acme',
    ips: ['203.0.113.10'],
  })),
  total: names.length,
  page: 1,
  page_size: 20,
});

let pending: Map<string, ReturnType<typeof deferred<Response>>>;
let requested: string[];

beforeEach(() => {
  pending = new Map();
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      requested.push(url);
      const d = deferred<Response>();
      pending.set(new URL(url, 'http://x').searchParams.get('q') ?? '', d);
      return d.promise; // ignores the abort signal on purpose
    }),
  );
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

function renderList(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/servers" element={<ServerList />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('server list', () => {
  it('a slow answer for an older search never replaces the newer results', async () => {
    const user = userEvent.setup();
    renderList('/servers');
    await act(async () => pending.get('')!.resolve(json(page(['web-1', 'db-1']))));
    expect(await screen.findByText('web-1')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search servers'), 'w');
    await waitFor(() => expect(pending.has('w')).toBe(true)); // request for "w" is in flight (slow)
    await user.type(screen.getByLabelText('Search servers'), 'e');
    await waitFor(() => expect(pending.has('we')).toBe(true));

    await act(async () => pending.get('we')!.resolve(json(page(['web-1']))));
    await waitFor(() => expect(screen.queryByText('db-1')).not.toBeInTheDocument());

    // now the old, slow answer for "w" arrives with different results
    await act(async () => pending.get('w')!.resolve(json(page(['web-1', 'wiki-OLD']))));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('wiki-OLD')).not.toBeInTheDocument();
    expect(screen.getByText('web-1')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/servers?q=we');
  });

  it('reads its state from the URL and sends only parameters the API knows', async () => {
    renderList('/servers?q=web&status=running,bogus&sort=name&order=asc&page=2&utm_source=mail');
    await waitFor(() => expect(requested).toHaveLength(1));
    const sent = new URL(requested[0]!, 'http://x').searchParams;
    expect(Object.fromEntries(sent)).toEqual({ q: 'web', status: 'running', sort: 'name', order: 'asc', page: '2', page_size: '20' });
    expect(screen.getByLabelText('Search servers')).toHaveValue('web');
    expect(screen.getByRole('checkbox', { name: 'running' })).toBeChecked();
  });

  it('shows loading, empty and failed as three different states', async () => {
    renderList('/servers?q=none');
    expect(screen.getByText(/Loading servers/)).toBeInTheDocument();
    await act(async () => pending.get('none')!.resolve(json(page([]))));
    expect(await screen.findByText('No servers match these filters.')).toBeInTheDocument();

    renderList('/servers?q=broken');
    await waitFor(() => expect(pending.has('broken')).toBe(true));
    await act(async () =>
      pending.get('broken')!.resolve(new Response(JSON.stringify({ error: { code: 'internal', message: 'internal error' } }), { status: 500 })),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load servers.');
    expect(alert).toHaveTextContent('internal error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
