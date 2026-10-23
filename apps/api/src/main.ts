import { createPool, migrate } from './db.ts';
import { buildApp } from './app.ts';
import { httpInfraClient } from './infra-client.ts';
import { seed } from './seed.ts';
import { pollProvisioning, processTerminations, provisionPending, reconcile, startWorkers } from './workers.ts';
import { runBilling } from './billing.ts';

const env = (name: string, fallback: string) => process.env[name] || fallback;

const db = createPool(env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/billing'));
const infraUrl = env('INFRA_URL', 'http://localhost:4001');
const infra = httpInfraClient(infraUrl);

const applied = await migrate(db);
const seeded = await seed(db);

const app = await buildApp({ db, infra, infraUrl, webDist: env('WEB_DIST', ''), logger: true });
app.log.info({ applied, seeded }, 'database ready');

let stopWorkers = () => {};
if (env('WORKERS', 'on') === 'on') {
  stopWorkers = startWorkers(
    [
      { name: 'provision', everyMs: 1000, run: () => provisionPending(db, infra) },
      { name: 'poll', everyMs: 1000, run: () => pollProvisioning(db, infra) },
      { name: 'terminate', everyMs: 1000, run: () => processTerminations(db, infra) },
      { name: 'reconcile', everyMs: Number(env('RECONCILE_EVERY_MS', '30000')), run: () => reconcile(db, infra) },
      { name: 'billing', everyMs: Number(env('BILLING_EVERY_MS', '60000')), run: () => runBilling(db) },
    ],
    (msg, err) => app.log.error({ err }, msg),
  );
}

const shutdown = async () => {
  stopWorkers();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: Number(env('PORT', '4000')) });
