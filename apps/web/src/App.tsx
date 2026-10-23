import { useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth';
import { ApiError } from './api/client';
import { ServerList } from './pages/ServerList';
import { ServerDetail } from './pages/ServerDetail';
import { CustomerDetail, CustomerList } from './pages/Customers';
import { IpDetail, IpList } from './pages/Ips';
import { Operations } from './pages/Operations';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AuthProvider>
  );
}

function Shell() {
  const { staff, checking, logout } = useAuth();
  if (checking) return <div className="state state-loading center">Checking your session…</div>;
  if (!staff) return <Login />;
  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">Billing Desk</div>
        <NavLink to="/servers">Servers</NavLink>
        <NavLink to="/customers">Customers</NavLink>
        <NavLink to="/ips">IP pool</NavLink>
        <NavLink to="/operations">Operations</NavLink>
        <div className="who">
          <span>{staff.name}</span>
          <span className={`badge badge-role-${staff.role}`}>{staff.role}</span>
          <button type="button" className="link-button" onClick={() => void logout()}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/servers" replace />} />
          <Route path="/servers" element={<ServerList />} />
          <Route path="/servers/:id" element={<ServerDetail />} />
          <Route path="/customers" element={<CustomerList />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/ips" element={<IpList />} />
          <Route path="/ips/:id" element={<IpDetail />} />
          <Route path="/operations" element={<Operations />} />
          <Route path="*" element={<div className="state state-empty">This page does not exist.</div>} />
        </Routes>
      </main>
    </div>
  );
}

function Login() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError(null);
          try {
            await login(String(f.get('email')), String(f.get('password')));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>Billing Desk</h1>
        <label><span>Email</span><input name="email" type="email" autoComplete="username" required defaultValue="owner@example.com" /></label>
        <label><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label>
        {error && <p className="error-note" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small">Demo accounts: owner@, support@, viewer@example.com with passwords owner-pass, support-pass, viewer-pass.</p>
      </form>
    </div>
  );
}
