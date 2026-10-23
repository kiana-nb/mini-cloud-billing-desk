import { describe, expect, it } from 'vitest';
import { buildInfraApp } from '../src/app.ts';

/** Random source that returns the scripted values first, then `fallback`. */
const scripted = (values: number[], fallback = 0.99) => () => values.shift() ?? fallback;

describe('fake infrastructure', () => {
  it('is slow: a new server is creating until provisionMs has passed', async () => {
    let t = 1_000;
    const app = buildInfraApp({ chaos: { failRate: 0, lieRate: 0, latencyMs: 0, provisionMs: 3000 }, now: () => t });
    const created = (await app.inject({ method: 'POST', url: '/servers', payload: { tag: 'a' } })).json();
    expect(created.status).toBe('creating');
    t += 3000;
    expect((await app.inject({ method: 'GET', url: `/servers/${created.id}` })).json().status).toBe('running');
  });

  it('is unreliable: a failed call does nothing', async () => {
    const app = buildInfraApp({ chaos: { failRate: 0.5, lieRate: 0, latencyMs: 0 }, random: scripted([0.1]) });
    const res = await app.inject({ method: 'POST', url: '/servers', payload: { tag: 'a' } });
    expect(res.statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/servers' })).json()).toEqual([]);
  });

  it('is dishonest: a lying call reports an error but the server exists', async () => {
    // first draw passes the fail check, second draw triggers the lie
    const app = buildInfraApp({ chaos: { failRate: 0.5, lieRate: 0.5, latencyMs: 0 }, random: scripted([0.9, 0.1]) });
    const res = await app.inject({ method: 'POST', url: '/servers', payload: { tag: 'a' } });
    expect(res.statusCode).toBe(500);
    const listed = (await app.inject({ method: 'GET', url: '/servers?tag=a' })).json();
    expect(listed).toHaveLength(1);
  });

  it('create is not idempotent, delete of a missing server is 404', async () => {
    const app = buildInfraApp({ chaos: { failRate: 0, lieRate: 0, latencyMs: 0 } });
    await app.inject({ method: 'POST', url: '/servers', payload: { tag: 'a' } });
    const second = (await app.inject({ method: 'POST', url: '/servers', payload: { tag: 'a' } })).json();
    expect((await app.inject({ method: 'GET', url: '/servers?tag=a' })).json()).toHaveLength(2);
    expect((await app.inject({ method: 'DELETE', url: `/servers/${second.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/servers/${second.id}` })).statusCode).toBe(404);
  });
});
