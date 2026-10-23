import { buildInfraApp, defaultChaos } from './app.ts';

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
};

const app = buildInfraApp({
  logger: true,
  chaos: {
    failRate: num('INFRA_FAIL_RATE', defaultChaos.failRate),
    lieRate: num('INFRA_LIE_RATE', defaultChaos.lieRate),
    provisionMs: num('INFRA_PROVISION_MS', defaultChaos.provisionMs),
    latencyMs: num('INFRA_LATENCY_MS', defaultChaos.latencyMs),
  },
});

await app.listen({ host: '0.0.0.0', port: num('PORT', 4001) });
