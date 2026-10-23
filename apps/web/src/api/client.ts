// Thin fetch wrapper: bearer token, JSON, abort signals and typed errors.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = 'billing-desk.token';

// Storage can be unavailable (private mode, blocked site data); the app then keeps the token in memory.
let memoryToken: string | null = null;
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}
export function setToken(token: string | null) {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // memory only
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export type RequestOptions = { signal?: AbortSignal; body?: unknown; idempotencyKey?: string };

export async function api<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, data?.error?.code ?? 'unknown', data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** Builds a query string from defined, non-empty values only. */
export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export type Page<T> = { items: T[]; total: number; page: number; page_size: number };

export type Role = 'owner' | 'support' | 'viewer';
export type Staff = { id: string; email: string; name: string; role: Role };

export type ServerStatus = 'pending' | 'provisioning' | 'running' | 'terminating' | 'terminated' | 'failed';
export const serverStatuses: ServerStatus[] = ['pending', 'provisioning', 'running', 'terminating', 'terminated', 'failed'];

export type ServerSummary = {
  id: string;
  name: string;
  status: ServerStatus;
  created_at: string;
  running_at: string | null;
  terminate_requested_at: string | null;
  terminated_at: string | null;
  restorable_until: string | null;
  last_error: string | null;
  customer_id: string;
  customer_name: string;
  ips: string[];
};

export type CustomerStatus = 'verified' | 'payment_notice' | 'suspended';
export type CustomerSummary = { id: string; name: string; email: string; balance: number; statuses: CustomerStatus[]; active_servers: number };

export type LedgerEntry = {
  id: number;
  kind: 'topup' | 'charge' | 'refund';
  amount: number;
  created_at: string;
  description: string;
  hour_start: string | null;
  refunded: boolean;
};
