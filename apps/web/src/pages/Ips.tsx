import { Link, useParams, useSearchParams } from 'react-router';
import { api, query, type Page } from '../api/client';
import { useLatestRequest } from '../lib/useLatestRequest';
import { AsyncState } from '../components/AsyncState';
import { Badge, Money, Pagination, Section, When } from '../components/ui';

type IpSummary = { id: number; address: string; server_id: string | null; server_name: string | null; customer_id: string | null; customer_name: string | null; since: string | null };

export function IpList() {
  const [params, setParams] = useSearchParams();
  const state = params.get('state') === 'free' || params.get('state') === 'assigned' ? params.get('state')! : '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const url = `/api/ips${query({ state: state || undefined, page, page_size: 25 })}`;
  const list = useLatestRequest(url, (signal) => api<Page<IpSummary>>('GET', url, { signal }));
  return (
    <div className="page">
      <header className="page-head"><h1>IP pool</h1></header>
      <div className="filters">
        <label>
          <span>Show</span>
          <select value={state} onChange={(e) => setParams(e.target.value ? { state: e.target.value } : {})}>
            <option value="">All addresses</option>
            <option value="free">Free</option>
            <option value="assigned">Assigned</option>
          </select>
        </label>
      </div>
      <AsyncState state={list} what="IP addresses" isEmpty={(d) => d.items.length === 0} empty="No addresses in this view.">
        {(d) => (
          <>
            <table className="table">
              <thead><tr><th>Address</th><th>Server</th><th>Customer</th><th>Since</th></tr></thead>
              <tbody>
                {d.items.map((ip) => (
                  <tr key={ip.id}>
                    <td className="mono"><Link to={`/ips/${ip.id}`}>{ip.address}</Link></td>
                    <td>{ip.server_id ? <Link to={`/servers/${ip.server_id}`}>{ip.server_name}</Link> : <Badge value="free" />}</td>
                    <td>{ip.customer_id ? <Link to={`/customers/${ip.customer_id}`}>{ip.customer_name}</Link> : null}</td>
                    <td><When at={ip.since} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={(p) => setParams({ ...(state ? { state } : {}), page: String(p) })} />
          </>
        )}
      </AsyncState>
    </div>
  );
}

type IpDetailData = {
  ip: { id: number; address: string };
  history: { id: number; server_id: string; server_name: string; customer_id: string; customer_name: string; since: string; until: string | null }[];
  charges: { id: number; hour_start: string; amount: number; customer_id: string; customer_name: string; server_name: string; refunded: boolean }[];
};

/** Everything needed to answer "did we charge them for an IP after they removed it?". */
export function IpDetail() {
  const { id = '' } = useParams();
  const state = useLatestRequest(id, (signal) => api<IpDetailData>('GET', `/api/ips/${id}`, { signal }));
  return (
    <div className="page">
      <AsyncState state={state} what="IP address">
        {(d) => (
          <>
            <header className="page-head">
              <div>
                <p className="crumbs"><Link to="/ips">IP pool</Link></p>
                <h1 className="mono">{d.ip.address}</h1>
              </div>
            </header>
            <Section title="Who held it">
              {d.history.length === 0 ? (
                <p className="state state-empty">Never assigned.</p>
              ) : (
                <table className="table">
                  <thead><tr><th>Customer</th><th>Server</th><th>From</th><th>Until</th></tr></thead>
                  <tbody>
                    {d.history.map((h) => (
                      <tr key={h.id}>
                        <td><Link to={`/customers/${h.customer_id}`}>{h.customer_name}</Link></td>
                        <td><Link to={`/servers/${h.server_id}`}>{h.server_name}</Link></td>
                        <td><When at={h.since} /></td>
                        <td>{h.until ? <When at={h.until} /> : <Badge value="current" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
            <Section title="Hourly charges for this IP">
              {d.charges.length === 0 ? (
                <p className="state state-empty">Never charged.</p>
              ) : (
                <table className="table">
                  <thead><tr><th>Hour (UTC)</th><th>Paid by</th><th>Via server</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {d.charges.map((c) => (
                      <tr key={c.id}>
                        <td><When at={c.hour_start} /></td>
                        <td><Link to={`/customers/${c.customer_id}`}>{c.customer_name}</Link></td>
                        <td>{c.server_name}</td>
                        <td className="num"><Money amount={c.amount} />{c.refunded && <span className="badge badge-refunded">refunded</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </>
        )}
      </AsyncState>
    </div>
  );
}
