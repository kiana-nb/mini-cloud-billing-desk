import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, query, type CustomerStatus, type CustomerSummary, type LedgerEntry, type Page, type ServerSummary } from '../api/client';
import { useLatestRequest } from '../lib/useLatestRequest';
import { useAuth } from '../lib/auth';
import { AsyncState } from '../components/AsyncState';
import { Badge, ErrorNote, Money, Pagination, Section, When, useAction } from '../components/ui';

const statuses: CustomerStatus[] = ['verified', 'payment_notice', 'suspended'];

export function CustomerList() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = statuses.includes(params.get('status') as CustomerStatus) ? (params.get('status') as CustomerStatus) : '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const set = (patch: Record<string, string>) =>
    setParams((cur) => {
      const next = new URLSearchParams(cur);
      for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
      if (!('page' in patch)) next.delete('page');
      return next;
    }, { replace: 'q' in patch });

  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => set({ q: text }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const url = `/api/customers${query({ q: q.trim() || undefined, status: status || undefined, page })}`;
  const state = useLatestRequest(url, (signal) => api<Page<CustomerSummary>>('GET', url, { signal }));
  const { can } = useAuth();

  return (
    <div className="page">
      <header className="page-head">
        <h1>Customers</h1>
        {can('operate') && <NewCustomer />}
      </header>
      <div className="filters" role="search">
        <label className="grow">
          <span>Search</span>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or email" aria-label="Search customers" />
        </label>
        <label>
          <span>Status</span>
          <select value={status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Any</option>
            {statuses.map((s) => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </select>
        </label>
      </div>
      <AsyncState state={state} what="customers" isEmpty={(d) => d.items.length === 0} empty={params.toString() ? 'No customers match these filters.' : 'No customers yet.'}>
        {(data) => (
          <>
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Statuses</th><th>Active servers</th><th className="num">Balance</th></tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/customers/${c.id}`}>{c.name}</Link></td>
                    <td>{c.email}</td>
                    <td>{c.statuses.length ? c.statuses.map((s) => <Badge key={s} value={s} />) : <span className="muted">—</span>}</td>
                    <td>{c.active_servers}</td>
                    <td className="num"><Money amount={c.balance} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </AsyncState>
    </div>
  );
}

function NewCustomer() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const create = useAction((_key, body: { name: string; email: string }) => api<{ id: string }>('POST', '/api/customers', { body }));
  if (!open) return <button type="button" onClick={() => setOpen(true)}>New customer</button>;
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const created = await create.run({ name: String(f.get('name')), email: String(f.get('email')) });
        if (created) navigate(`/customers/${created.id}`);
      }}
    >
      <input name="name" placeholder="Name" required aria-label="Customer name" />
      <input name="email" type="email" placeholder="Email" required aria-label="Customer email" />
      <button type="submit" disabled={create.busy}>Create</button>
      <button type="button" className="link-button" onClick={() => setOpen(false)}>Cancel</button>
      <ErrorNote error={create.error} />
    </form>
  );
}

type CustomerDetailData = {
  customer: { id: string; name: string; email: string; created_at: string };
  balance: number;
  statuses: CustomerStatus[];
  status_history: { status: CustomerStatus; set_at: string; cleared_at: string | null; reason: string }[];
  servers: ServerSummary[];
};

export function CustomerDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const detail = useLatestRequest(`${id}:${version}`, (signal) => api<CustomerDetailData>('GET', `/api/customers/${id}`, { signal }));
  const [ledgerPage, setLedgerPage] = useState(1);
  const ledgerUrl = `/api/customers/${id}/ledger${query({ page: ledgerPage })}`;
  const ledger = useLatestRequest(`${ledgerUrl}:${version}`, (signal) => api<Page<LedgerEntry>>('GET', ledgerUrl, { signal }));

  const setStatus = useAction((_key, status: CustomerStatus, on: boolean) =>
    api(on ? 'PUT' : 'DELETE', `/api/customers/${id}/statuses/${status}`, on ? { body: { reason: 'set by staff' } } : {}),
  );
  const refund = useAction((_key, entryId: number) => api('POST', `/api/ledger/${entryId}/refund`, { body: { reason: 'refunded by staff' } }));

  return (
    <div className="page">
      <AsyncState state={detail} what="customer">
        {(d) => (
          <>
            <header className="page-head">
              <div>
                <p className="crumbs"><Link to="/customers">Customers</Link></p>
                <h1>{d.customer.name}</h1>
                <p className="muted">{d.customer.email}</p>
              </div>
              <div className="balance">
                <span className="muted">Balance</span>
                <strong><Money amount={d.balance} /></strong>
              </div>
            </header>

            <Section title="Statuses">
              <div className="status-row">
                {statuses.map((s) => {
                  const on = d.statuses.includes(s);
                  return (
                    <label key={s} className={`toggle ${on ? 'on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!can('operate') || setStatus.busy}
                        onChange={async () => (await setStatus.run(s, !on)) !== undefined && refresh()}
                      />
                      <Badge value={s} />
                    </label>
                  );
                })}
              </div>
              <ErrorNote error={setStatus.error} />
              <details>
                <summary>Status history ({d.status_history.length})</summary>
                <ul className="plain">
                  {d.status_history.map((h, i) => (
                    <li key={i}>
                      <Badge value={h.status} /> <When at={h.set_at} /> → {h.cleared_at ? <When at={h.cleared_at} /> : 'now'} <span className="muted">{h.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </Section>

            {can('money') && <TopUp customerId={id} onDone={refresh} />}

            <Section
              title="Servers"
              actions={can('operate') ? <NewServer customerId={id} onDone={refresh} /> : null}
            >
              {d.servers.length === 0 ? (
                <p className="state state-empty">This customer has no servers.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr><th>Name</th><th>Status</th><th>IPs</th><th>Created</th></tr>
                  </thead>
                  <tbody>
                    {d.servers.map((s) => (
                      <tr key={s.id}>
                        <td><Link to={`/servers/${s.id}`}>{s.name}</Link></td>
                        <td><Badge value={s.status} /></td>
                        <td className="mono">{s.ips.join(', ') || <span className="muted">none</span>}</td>
                        <td><When at={s.created_at} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p><Link to={`/servers?customer_id=${id}`}>Open in the server list →</Link></p>
            </Section>
          </>
        )}
      </AsyncState>

      <Section title="Money history">
        <ErrorNote error={refund.error} />
        <AsyncState state={ledger} what="money history" isEmpty={(l) => l.items.length === 0} empty="No money movements yet.">
          {(l) => (
            <>
              <table className="table">
                <thead>
                  <tr><th>#</th><th>When</th><th>Kind</th><th>Description</th><th className="num">Amount</th><th /></tr>
                </thead>
                <tbody>
                  {l.items.map((e) => (
                    <tr key={e.id}>
                      <td className="muted">{e.id}</td>
                      <td><When at={e.created_at} /></td>
                      <td><Badge value={e.kind} /></td>
                      <td>{e.description}</td>
                      <td className="num"><Money amount={e.amount} /></td>
                      <td>
                        {e.kind === 'charge' && (e.refunded ? <span className="badge badge-refunded">refunded</span> : can('money') && (
                          <button type="button" className="link-button" disabled={refund.busy} onClick={async () => {
                            if (confirm(`Refund charge #${e.id}?`) && (await refund.run(e.id)) !== undefined) refresh();
                          }}>Refund</button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={l.page} pageSize={l.page_size} total={l.total} onPage={setLedgerPage} />
            </>
          )}
        </AsyncState>
      </Section>
    </div>
  );
}

function TopUp({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  // the key survives a failed attempt, so "Add money" after a timeout cannot add it twice
  const topup = useAction((key, value: number) =>
    api('POST', `/api/customers/${customerId}/topups`, { body: { amount: value, description: 'Top-up by staff' }, idempotencyKey: key }),
  );
  return (
    <Section title="Add money">
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const value = Number(amount);
          if (!Number.isInteger(value) || value <= 0) return;
          if ((await topup.run(value)) !== undefined) {
            setAmount('');
            onDone();
          }
        }}
      >
        <input
          inputMode="numeric"
          pattern="[0-9]+"
          placeholder="Whole credits"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            topup.reset(); // a different amount is a different request
          }}
          aria-label="Top-up amount"
          required
        />
        <button type="submit" disabled={topup.busy}>{topup.busy ? 'Adding…' : 'Add money'}</button>
        <ErrorNote error={topup.error} />
      </form>
    </Section>
  );
}

function NewServer({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const create = useAction((key, value: string) => api('POST', '/api/servers', { body: { customer_id: customerId, name: value }, idempotencyKey: key }));
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if ((await create.run(name)) !== undefined) {
          setName('');
          onDone();
        }
      }}
    >
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value.toLowerCase());
          create.reset();
        }}
        placeholder="server-name"
        pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
        aria-label="New server name"
        required
      />
      <button type="submit" disabled={create.busy}>Create server</button>
      <ErrorNote error={create.error} />
    </form>
  );
}
