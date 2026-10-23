import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, query, serverStatuses, type Page, type ServerStatus, type ServerSummary } from '../api/client';
import { useLatestRequest } from '../lib/useLatestRequest';
import { AsyncState } from '../components/AsyncState';
import { Badge, Pagination, When } from '../components/ui';

const sorts = ['created_at', 'name', 'status', 'customer'] as const;
type Sort = (typeof sorts)[number];
const PAGE_SIZE = 20;

export type ServerFilters = { q: string; status: ServerStatus[]; customerId: string; sort: Sort; order: 'asc' | 'desc'; page: number };

/**
 * The URL is the single source of truth for the list's state, so it survives a reload and
 * can be shared. Values the app does not understand are dropped here instead of being sent
 * on: the API rejects unknown parameters.
 */
export function readFilters(params: URLSearchParams): ServerFilters {
  const status = (params.get('status') ?? '')
    .split(',')
    .filter((s): s is ServerStatus => (serverStatuses as string[]).includes(s));
  const sort = params.get('sort');
  const page = Number(params.get('page'));
  const customerId = params.get('customer_id') ?? '';
  return {
    q: params.get('q') ?? '',
    status,
    customerId: /^[0-9a-f-]{36}$/i.test(customerId) ? customerId : '',
    sort: (sorts as readonly string[]).includes(sort ?? '') ? (sort as Sort) : 'created_at',
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function writeFilters(f: ServerFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.q) out.q = f.q;
  if (f.status.length) out.status = f.status.join(',');
  if (f.customerId) out.customer_id = f.customerId;
  if (f.sort !== 'created_at') out.sort = f.sort;
  if (f.order !== 'desc') out.order = f.order;
  if (f.page > 1) out.page = String(f.page);
  return out;
}

export function serverListUrl(f: ServerFilters): string {
  return `/api/servers${query({
    q: f.q.trim() || undefined,
    status: f.status.join(',') || undefined,
    customer_id: f.customerId || undefined,
    sort: f.sort,
    order: f.order,
    page: f.page,
    page_size: PAGE_SIZE,
  })}`;
}

export function ServerList() {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  // Reads the current URL at update time, so a delayed search update cannot undo a filter
  // the user changed in the meantime. Any change except paging goes back to page 1.
  const update = (patch: Partial<ServerFilters>, replace = false) =>
    setParams((current) => writeFilters({ ...readFilters(current), page: 1, ...patch }), { replace });

  // The search box updates the URL 300 ms after the last keystroke, replacing the history
  // entry so typing does not flood the back button.
  const [text, setText] = useState(filters.q);
  useEffect(() => setText(filters.q), [filters.q]);
  useEffect(() => {
    if (text === filters.q) return;
    const t = setTimeout(() => update({ q: text }, true), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const url = serverListUrl(filters);
  const state = useLatestRequest(url, (signal) => api<Page<ServerSummary>>('GET', url, { signal }));
  const hasFilters = params.toString() !== '';

  return (
    <div className="page">
      <header className="page-head">
        <h1>Servers</h1>
      </header>

      <div className="filters" role="search">
        <label className="grow">
          <span>Search</span>
          <input
            type="search"
            placeholder="Name, customer, email, IP or server id"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Search servers"
          />
        </label>
        <fieldset className="status-filter">
          <legend>Status</legend>
          {serverStatuses.map((s) => (
            <label key={s} className="check">
              <input
                type="checkbox"
                checked={filters.status.includes(s)}
                onChange={(e) => update({ status: e.target.checked ? [...filters.status, s] : filters.status.filter((x) => x !== s) })}
              />
              {s}
            </label>
          ))}
        </fieldset>
        <label>
          <span>Sort</span>
          <select value={`${filters.sort}:${filters.order}`} onChange={(e) => {
            const [sort, order] = e.target.value.split(':') as [Sort, 'asc' | 'desc'];
            update({ sort, order });
          }}>
            <option value="created_at:desc">Newest first</option>
            <option value="created_at:asc">Oldest first</option>
            <option value="name:asc">Name A–Z</option>
            <option value="status:asc">Status</option>
            <option value="customer:asc">Customer</option>
          </select>
        </label>
        {filters.customerId && (
          <button type="button" className="chip" onClick={() => update({ customerId: '' })}>
            One customer only ✕
          </button>
        )}
        {hasFilters && (
          <button type="button" className="link-button" onClick={() => setParams({})}>
            Clear filters
          </button>
        )}
      </div>

      <AsyncState
        state={state}
        what="servers"
        isEmpty={(d) => d.items.length === 0}
        empty={hasFilters ? 'No servers match these filters.' : 'No servers yet.'}
      >
        {(data) => (
          <>
            <table className="table" data-testid="server-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Customer</th>
                  <th>IPs</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/servers/${s.id}`}>{s.name}</Link>
                    </td>
                    <td>
                      <Badge value={s.status} />
                    </td>
                    <td>
                      <Link to={`/customers/${s.customer_id}`}>{s.customer_name}</Link>
                    </td>
                    <td className="mono">{s.ips.join(', ') || <span className="muted">none</span>}</td>
                    <td>
                      <When at={s.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPage={(page) => update({ page })} />
          </>
        )}
      </AsyncState>
    </div>
  );
}
