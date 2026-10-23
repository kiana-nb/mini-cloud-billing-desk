import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, query, type Page, type ServerSummary } from '../api/client';
import { useLatestRequest } from '../lib/useLatestRequest';
import { useAuth } from '../lib/auth';
import { AsyncState } from '../components/AsyncState';
import { Badge, ErrorNote, Money, Pagination, Section, When, useAction } from '../components/ui';

type IpRow = { assignment_id: number; ip_id: number; address: string; since: string; until: string | null; customer_name: string };
type Detail = { server: ServerSummary; ips: IpRow[]; ip_history: IpRow[]; usage: { started_at: string; ended_at: string | null }[] };
type Charge = { id: number; amount: number; description: string; hour_start: string; ip_address: string | null; price: number; refunded: boolean };

export function ServerDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const detail = useLatestRequest(`${id}:${version}`, (signal) => api<Detail>('GET', `/api/servers/${id}`, { signal }));
  const [chargePage, setChargePage] = useState(1);
  const chargesUrl = `/api/servers/${id}/charges${query({ page: chargePage })}`;
  const charges = useLatestRequest(`${chargesUrl}:${version}`, (signal) => api<Page<Charge>>('GET', chargesUrl, { signal }));

  const terminate = useAction((_key) => api('POST', `/api/servers/${id}/terminate`, { body: { reason: 'requested by staff' } }));
  const restore = useAction((_key) => api<{ oldIpRestored: boolean }>('POST', `/api/servers/${id}/restore`, { body: {} }));
  const addIp = useAction((key) => api('POST', `/api/servers/${id}/ips`, { body: {}, idempotencyKey: key }));
  const release = useAction((_key, ipId: number) => api('DELETE', `/api/servers/${id}/ips/${ipId}`));
  const [restoreNote, setRestoreNote] = useState<string | null>(null);

  return (
    <div className="page">
      <AsyncState state={detail} what="server">
        {({ server, ips, ip_history, usage }) => {
          const alive = ['pending', 'provisioning', 'running'].includes(server.status);
          return (
            <>
              <header className="page-head">
                <div>
                  <p className="crumbs">
                    <Link to="/servers">Servers</Link> / <Link to={`/customers/${server.customer_id}`}>{server.customer_name}</Link>
                  </p>
                  <h1>
                    {server.name} <Badge value={server.status} />
                  </h1>
                  <p className="muted mono">{server.id}</p>
                </div>
                {can('operate') && (
                  <div className="actions">
                    {alive && (
                      <button
                        type="button"
                        className="danger"
                        disabled={terminate.busy}
                        onClick={async () => {
                          if (!confirm(`Terminate ${server.name}? Billing stops now and its IPs return to the pool.`)) return;
                          if (await terminate.run()) refresh();
                        }}
                      >
                        {terminate.busy ? 'Terminating…' : 'Terminate'}
                      </button>
                    )}
                    {server.status === 'terminated' && server.restorable_until && (
                      <button
                        type="button"
                        disabled={restore.busy}
                        onClick={async () => {
                          const r = await restore.run();
                          if (r) {
                            setRestoreNote(r.oldIpRestored ? 'Restored with its old IP.' : 'Restored. Its old IP was taken, so it got a new one.');
                            refresh();
                          }
                        }}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                )}
              </header>
              <ErrorNote error={terminate.error ?? restore.error} />
              {restoreNote && <p className="ok-note">{restoreNote}</p>}

              <dl className="facts">
                <dt>Created</dt>
                <dd><When at={server.created_at} /></dd>
                <dt>Running since</dt>
                <dd><When at={server.running_at} /></dd>
                <dt>Termination requested</dt>
                <dd><When at={server.terminate_requested_at} /></dd>
                <dt>Terminated</dt>
                <dd><When at={server.terminated_at} /></dd>
                {server.restorable_until && (
                  <>
                    <dt>Restorable until</dt>
                    <dd><When at={server.restorable_until} /></dd>
                  </>
                )}
                {server.last_error && (
                  <>
                    <dt>Last infrastructure problem</dt>
                    <dd className="muted">{server.last_error}</dd>
                  </>
                )}
              </dl>

              <Section
                title="IP addresses"
                actions={
                  can('operate') && alive ? (
                    <button type="button" disabled={addIp.busy} onClick={async () => (await addIp.run()) && refresh()}>
                      Add IP
                    </button>
                  ) : null
                }
              >
                <ErrorNote error={addIp.error ?? release.error} />
                {ips.length === 0 ? (
                  <p className="state state-empty">No IP is attached.</p>
                ) : (
                  <table className="table">
                    <thead>
                      <tr><th>Address</th><th>Since</th><th /></tr>
                    </thead>
                    <tbody>
                      {ips.map((ip) => (
                        <tr key={ip.assignment_id}>
                          <td className="mono"><Link to={`/ips/${ip.ip_id}`}>{ip.address}</Link></td>
                          <td><When at={ip.since} /></td>
                          <td className="row-actions">
                            {can('operate') && (
                              <>
                                <MoveIp ipId={ip.ip_id} fromServerId={server.id} onMoved={refresh} />
                                <button type="button" className="link-button" onClick={async () => (await release.run(ip.ip_id)) !== undefined && refresh()}>
                                  Release
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <details>
                  <summary>IP history ({ip_history.length})</summary>
                  <table className="table compact">
                    <tbody>
                      {ip_history.map((ip) => (
                        <tr key={ip.assignment_id}>
                          <td className="mono">{ip.address}</td>
                          <td><When at={ip.since} /> → {ip.until ? <When at={ip.until} /> : 'now'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </Section>

              <Section title="Running periods (billed)">
                {usage.length === 0 ? (
                  <p className="state state-empty">The server has not run yet, so nothing is billed.</p>
                ) : (
                  <ul className="plain">
                    {usage.map((u) => (
                      <li key={u.started_at}>
                        <When at={u.started_at} /> → {u.ended_at ? <When at={u.ended_at} /> : 'now'}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          );
        }}
      </AsyncState>

      <Section title="Billing history">
        <AsyncState state={charges} what="billing history" isEmpty={(d) => d.items.length === 0} empty="Nothing has been charged for this server yet.">
          {(data) => (
            <>
              <table className="table">
                <thead>
                  <tr><th>Hour (UTC)</th><th>Item</th><th>Price</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr key={c.id}>
                      <td><When at={c.hour_start} /></td>
                      <td>{c.ip_address ? `IP ${c.ip_address}` : 'Server'}{c.refunded && <span className="badge badge-refunded">refunded</span>}</td>
                      <td><Money amount={c.price} />/h</td>
                      <td><Money amount={c.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPage={setChargePage} />
            </>
          )}
        </AsyncState>
      </Section>
    </div>
  );
}

/** Moves an IP to another server. The target is searched with the same stale-safe hook. */
function MoveIp({ ipId, fromServerId, onMoved }: { ipId: number; fromServerId: string; onMoved: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const url = `/api/servers${query({ q: q.trim() || undefined, status: 'pending,provisioning,running', page_size: 8 })}`;
  const targets = useLatestRequest(open ? url : 'closed', (signal) =>
    open ? api<Page<ServerSummary>>('GET', url, { signal }) : Promise.resolve({ items: [], total: 0, page: 1, page_size: 8 }),
  );
  const move = useAction((_key, to: string) => api<{ moved: boolean }>('POST', `/api/ips/${ipId}/move`, { body: { from_server_id: fromServerId, to_server_id: to } }));

  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        Move…
      </button>
    );
  }
  return (
    <div className="popover" role="dialog" aria-label="Move IP">
      <input autoFocus placeholder="Find target server" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find target server" />
      <AsyncState state={targets} what="servers" isEmpty={(d) => d.items.filter((s) => s.id !== fromServerId).length === 0} empty="No other active server matches.">
        {(data) => (
          <ul className="plain">
            {data.items
              .filter((s) => s.id !== fromServerId)
              .map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="link-button"
                    disabled={move.busy}
                    onClick={async () => {
                      if ((await move.run(s.id)) !== undefined) {
                        setOpen(false);
                        onMoved();
                      }
                    }}
                  >
                    {s.name} <span className="muted">({s.customer_name})</span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </AsyncState>
      <ErrorNote error={move.error} />
      <button type="button" className="link-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
