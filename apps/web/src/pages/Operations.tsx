import { useState } from 'react';
import { Link } from 'react-router';
import { api, type Page } from '../api/client';
import { useLatestRequest } from '../lib/useLatestRequest';
import { useAuth } from '../lib/auth';
import { AsyncState } from '../components/AsyncState';
import { ErrorNote, Money, Section, When, useAction } from '../components/ui';

type Clock = { now: string; frozen: boolean };
type Run = { id: number; started_at: string; finished_at: string | null; as_of: string; items_total: number; items_failed: number; charges_created: number; failures: { resource: string; resource_id: string; error: string }[] };
type Price = { id: number; resource: 'server' | 'ip'; amount_per_hour: number; effective_from: string; upcoming: boolean; current: boolean };
type Drift = { id: number; at: string; kind: string; server_id: string | null; server_name: string | null; infra_id: string | null; detail: string };
type Chaos = { failRate: number; lieRate: number; provisionMs: number; latencyMs: number };

/** Clock, billing runs, prices, drift and the fake infrastructure's behaviour. */
export function Operations() {
  const { can } = useAuth();
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const v = String(version);
  const clock = useLatestRequest(`clock${v}`, (s) => api<Clock>('GET', '/api/clock', { signal: s }));
  const runs = useLatestRequest(`runs${v}`, (s) => api<Page<Run>>('GET', '/api/billing/runs?page_size=10', { signal: s }));
  const prices = useLatestRequest(`prices${v}`, (s) => api<{ items: Price[] }>('GET', '/api/prices', { signal: s }));
  const drift = useLatestRequest(`drift${v}`, (s) => api<Page<Drift>>('GET', '/api/drift-events?page_size=15', { signal: s }));
  const chaos = useLatestRequest(`chaos${v}`, (s) => api<Chaos>('GET', '/api/infra/chaos', { signal: s }));

  const advance = useAction((_k, hours: number, minutes: number) => api('POST', '/api/clock/advance', { body: { hours, minutes } }));
  const freeze = useAction((_k, frozen: boolean) => api('POST', '/api/clock/freeze', { body: { frozen } }));
  const bill = useAction(() => api('POST', '/api/billing/run', { body: {} }));
  const reconcile = useAction(() => api('POST', '/api/reconcile', { body: {} }));
  const setPrice = useAction((_k, resource: string, amount: number) => api('POST', '/api/prices', { body: { resource, amount_per_hour: amount } }));
  const setChaos = useAction((_k, body: Partial<Chaos>) => api('PUT', '/api/infra/chaos', { body }));
  const after = (p: Promise<unknown>) => p.then((r) => r !== undefined && refresh());

  return (
    <div className="page">
      <header className="page-head"><h1>Operations</h1></header>

      <Section title="Application clock">
        <AsyncState state={clock} what="clock">
          {(c) => (
            <div className="clock">
              <p>
                <strong><When at={c.now} /></strong> {c.frozen ? '(frozen)' : '(ticking)'}
              </p>
              {can('system') && (
                <div className="actions">
                  <button type="button" onClick={() => after(advance.run(0, 30))}>+30 min</button>
                  <button type="button" onClick={() => after(advance.run(1, 0))}>+1 hour</button>
                  <button type="button" onClick={() => after(advance.run(6, 0))}>+6 hours</button>
                  <button type="button" onClick={() => after(advance.run(24, 0))}>+1 day</button>
                  <button type="button" className="link-button" onClick={() => after(freeze.run(!c.frozen))}>{c.frozen ? 'Let it tick' : 'Freeze'}</button>
                </div>
              )}
              <ErrorNote error={advance.error ?? freeze.error} />
              <p className="muted">All billing uses this clock. It only moves forward.</p>
            </div>
          )}
        </AsyncState>
      </Section>

      <Section title="Billing runs" actions={can('money') ? <button type="button" disabled={bill.busy} onClick={() => after(bill.run())}>Run billing now</button> : null}>
        <ErrorNote error={bill.error} />
        <AsyncState state={runs} what="billing runs" isEmpty={(d) => d.items.length === 0} empty="Billing has not run yet.">
          {(d) => (
            <table className="table">
              <thead><tr><th>#</th><th>As of (app clock)</th><th>Items</th><th>Charges created</th><th>Failed items</th></tr></thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td><When at={r.as_of} />{!r.finished_at && <span className="badge badge-failed">did not finish</span>}</td>
                    <td>{r.items_total}</td>
                    <td>{r.charges_created}</td>
                    <td>
                      {r.items_failed === 0 ? '0' : (
                        <details>
                          <summary className="error-text">{r.items_failed} failed</summary>
                          <ul className="plain">{r.failures.map((f, i) => <li key={i}>{f.resource} {f.resource_id}: {f.error}</li>)}</ul>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AsyncState>
      </Section>

      <Section title="Prices per hour">
        <AsyncState state={prices} what="prices">
          {(d) => (
            <>
              <table className="table">
                <thead><tr><th>Resource</th><th>Price</th><th>From</th><th /></tr></thead>
                <tbody>
                  {d.items.slice(0, 10).map((p) => (
                    <tr key={p.id}>
                      <td>{p.resource}</td>
                      <td><Money amount={p.amount_per_hour} />/h</td>
                      <td><When at={p.effective_from} /></td>
                      <td>{p.current ? <span className="badge badge-running">current</span> : p.upcoming ? <span className="badge badge-pending">next hour</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {can('money') && (
                <form className="inline-form" onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void after(setPrice.run(String(f.get('resource')), Number(f.get('amount'))));
                }}>
                  <select name="resource" aria-label="Resource"><option value="server">server</option><option value="ip">ip</option></select>
                  <input name="amount" inputMode="numeric" pattern="[0-9]+" placeholder="credits per hour" required aria-label="New price" />
                  <button type="submit">Set price from next hour</button>
                  <ErrorNote error={setPrice.error} />
                </form>
              )}
            </>
          )}
        </AsyncState>
      </Section>

      <Section title="Infrastructure drift" actions={can('operate') ? <button type="button" disabled={reconcile.busy} onClick={() => after(reconcile.run())}>Reconcile now</button> : null}>
        <ErrorNote error={reconcile.error} />
        <AsyncState state={drift} what="drift events" isEmpty={(d) => d.items.length === 0} empty="No drift found so far.">
          {(d) => (
            <table className="table compact">
              <thead><tr><th>When</th><th>What</th><th>Server</th><th>Detail</th></tr></thead>
              <tbody>
                {d.items.map((e) => (
                  <tr key={e.id}>
                    <td><When at={e.at} /></td>
                    <td><code>{e.kind}</code></td>
                    <td>{e.server_id ? <Link to={`/servers/${e.server_id}`}>{e.server_name}</Link> : <span className="mono muted">{e.infra_id}</span>}</td>
                    <td className="muted">{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AsyncState>
      </Section>

      <Section title="Fake infrastructure behaviour">
        <AsyncState state={chaos} what="infrastructure settings">
          {(c) => (
            <form className="chaos" onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void after(setChaos.run({
                failRate: Number(f.get('failRate')) / 100,
                lieRate: Number(f.get('lieRate')) / 100,
                provisionMs: Number(f.get('provisionMs')),
              }));
            }}>
              <label><span>Calls that fail (%)</span><input name="failRate" type="number" min={0} max={100} defaultValue={Math.round(c.failRate * 100)} disabled={!can('system')} /></label>
              <label><span>Calls that lie (%)</span><input name="lieRate" type="number" min={0} max={100} defaultValue={Math.round(c.lieRate * 100)} disabled={!can('system')} /></label>
              <label><span>Provisioning time (ms)</span><input name="provisionMs" type="number" min={0} max={120000} defaultValue={c.provisionMs} disabled={!can('system')} /></label>
              {can('system') && <button type="submit">Save</button>}
              <ErrorNote error={setChaos.error} />
            </form>
          )}
        </AsyncState>
      </Section>
    </div>
  );
}
