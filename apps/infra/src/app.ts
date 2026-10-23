// Fake infrastructure service. It pretends to create, stop and delete servers and
// misbehaves on purpose:
//   - slow:       a created server is "creating" for `provisionMs` before it is "running";
//   - unreliable: a `failRate` share of calls fail without doing anything (503);
//   - dishonest:  a `lieRate` share of mutating calls do the work and still answer 500.
// State lives in memory. Create is NOT idempotent: calling it twice creates two servers,
// exactly like many real providers. Callers can tag a server and look it up by tag.
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

export type ChaosConfig = {
  failRate: number;
  lieRate: number;
  provisionMs: number;
  latencyMs: number;
};

export type InfraServer = {
  id: string;
  tag: string | null;
  status: 'creating' | 'running' | 'stopped';
  createdAt: string;
};

type StoredServer = { id: string; tag: string | null; createdAtMs: number; stopped: boolean };

export type InfraOptions = {
  chaos?: Partial<ChaosConfig>;
  /** Random source in [0, 1). Injected so tests can script failures. */
  random?: () => number;
  now?: () => number;
  logger?: boolean;
};

export const defaultChaos: ChaosConfig = { failRate: 0.2, lieRate: 0.1, provisionMs: 3000, latencyMs: 200 };

export function buildInfraApp(options: InfraOptions = {}): FastifyInstance {
  const chaos: ChaosConfig = { ...defaultChaos, ...options.chaos };
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const servers = new Map<string, StoredServer>();

  const app = Fastify({ logger: options.logger ?? false });

  const view = (s: StoredServer): InfraServer => ({
    id: s.id,
    tag: s.tag,
    status: s.stopped ? 'stopped' : now() - s.createdAtMs >= chaos.provisionMs ? 'running' : 'creating',
    createdAt: new Date(s.createdAtMs).toISOString(),
  });

  const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  /**
   * Runs `action` under the chaos rules. Returns the payload to send, or throws a reply
   * marker. `mutating` calls can lie; reads can only fail.
   */
  async function chaotic<T>(mutating: boolean, action: () => T): Promise<{ ok: true; value: T } | { ok: false; status: number; message: string }> {
    await sleep(chaos.latencyMs);
    if (random() < chaos.failRate) return { ok: false, status: 503, message: 'infrastructure unavailable' };
    const value = action();
    if (mutating && random() < chaos.lieRate) return { ok: false, status: 500, message: 'internal error' };
    return { ok: true, value };
  }

  app.get('/health', async () => ({ ok: true }));

  app.get('/_chaos', async () => chaos);
  app.put<{ Body: Partial<ChaosConfig> }>('/_chaos', async (req) => {
    for (const key of Object.keys(defaultChaos) as (keyof ChaosConfig)[]) {
      const value = req.body?.[key];
      if (typeof value === 'number' && value >= 0) chaos[key] = value;
    }
    return chaos;
  });

  app.post<{ Body: { tag?: string } }>('/servers', async (req, reply) => {
    const result = await chaotic(true, () => {
      const s: StoredServer = { id: `srv-${randomUUID()}`, tag: req.body?.tag ?? null, createdAtMs: now(), stopped: false };
      servers.set(s.id, s);
      return view(s);
    });
    if (!result.ok) return reply.code(result.status).send({ error: result.message });
    return reply.code(201).send(result.value);
  });

  app.get<{ Querystring: { tag?: string } }>('/servers', async (req, reply) => {
    const result = await chaotic(false, () =>
      [...servers.values()].filter((s) => req.query.tag === undefined || s.tag === req.query.tag).map(view),
    );
    if (!result.ok) return reply.code(result.status).send({ error: result.message });
    return result.value;
  });

  app.get<{ Params: { id: string } }>('/servers/:id', async (req, reply) => {
    const result = await chaotic(false, () => servers.get(req.params.id));
    if (!result.ok) return reply.code(result.status).send({ error: result.message });
    if (!result.value) return reply.code(404).send({ error: 'not found' });
    return view(result.value);
  });

  app.post<{ Params: { id: string } }>('/servers/:id/stop', async (req, reply) => {
    const result = await chaotic(true, () => {
      const s = servers.get(req.params.id);
      if (s) s.stopped = true;
      return s;
    });
    if (!result.ok) return reply.code(result.status).send({ error: result.message });
    if (!result.value) return reply.code(404).send({ error: 'not found' });
    return view(result.value);
  });

  app.delete<{ Params: { id: string } }>('/servers/:id', async (req, reply) => {
    const result = await chaotic(true, () => servers.delete(req.params.id));
    if (!result.ok) return reply.code(result.status).send({ error: result.message });
    if (!result.value) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  return app;
}
