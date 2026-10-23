// Client for the infrastructure service. Every call has a deadline. Results are typed so
// the caller must decide what to do with an unknown outcome:
//   ok        - the service answered and we trust the answer;
//   notFound  - the service says the thing does not exist (a trustworthy read);
//   unknown   - error, timeout or a 5xx: the action may or may not have happened.
export type InfraServer = { id: string; tag: string | null; status: 'creating' | 'running' | 'stopped'; createdAt: string };

export type InfraResult<T> = { kind: 'ok'; value: T } | { kind: 'notFound' } | { kind: 'unknown'; error: string };

export interface InfraClient {
  create(tag: string): Promise<InfraResult<InfraServer>>;
  get(id: string): Promise<InfraResult<InfraServer>>;
  findByTag(tag: string): Promise<InfraResult<InfraServer[]>>;
  list(): Promise<InfraResult<InfraServer[]>>;
  remove(id: string): Promise<InfraResult<null>>;
}

export function httpInfraClient(baseUrl: string, timeoutMs = 10_000): InfraClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<InfraResult<T>> {
    try {
      const res = await fetch(baseUrl + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return { kind: 'notFound' };
      if (!res.ok) return { kind: 'unknown', error: `infrastructure answered ${res.status}` };
      const value = res.status === 204 ? null : await res.json();
      return { kind: 'ok', value: value as T };
    } catch (err) {
      return { kind: 'unknown', error: (err as Error).message };
    }
  }
  return {
    create: (tag) => call('POST', '/servers', { tag }),
    get: (id) => call('GET', `/servers/${encodeURIComponent(id)}`),
    findByTag: (tag) => call('GET', `/servers?tag=${encodeURIComponent(tag)}`),
    list: () => call('GET', '/servers'),
    remove: (id) => call('DELETE', `/servers/${encodeURIComponent(id)}`),
  };
}
