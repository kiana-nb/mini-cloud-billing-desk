import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler, type Role, type Staff } from '../api/client';

type AuthState = {
  staff: Staff | null;
  checking: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Mirrors the server's rules to hide buttons; the server enforces them regardless. */
  can: (permission: 'operate' | 'money' | 'system') => boolean;
};

const AuthContext = createContext<AuthState | null>(null);

const allowed: Record<Role, string[]> = { owner: ['operate', 'money', 'system'], support: ['operate'], viewer: [] };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [checking, setChecking] = useState(() => getToken() !== null);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setStaff(null);
    });
    if (!getToken()) return;
    api<Staff>('GET', '/api/me')
      .then(setStaff)
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const session = await api<{ token: string; staff: Staff }>('POST', '/api/auth/login', { body: { email, password } });
    setToken(session.token);
    setStaff(session.staff);
  }, []);

  const logout = useCallback(async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    setToken(null);
    setStaff(null);
  }, []);

  const can = useCallback((p: 'operate' | 'money' | 'system') => (staff ? allowed[staff.role].includes(p) : false), [staff]);

  return <AuthContext.Provider value={{ staff, checking, login, logout, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
