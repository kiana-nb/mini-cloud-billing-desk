# Mini-Cloud Billing Desk

The billing back office of a small cloud provider: wallets, servers, IP addresses, hourly
billing and an admin panel, built to stay correct while a fake infrastructure service is
slow, fails and lies.

- Presentation: [`docs/presentation/presentation.pdf`](docs/presentation/presentation.pdf)
- Diagrams (Mermaid, editable and diffable): [`docs/diagrams/`](docs/diagrams)
- Regression tests seen failing without their fix: [`docs/regression-evidence.md`](docs/regression-evidence.md)

## Start

Requirements: Docker with Compose. Nothing else, no accounts or keys.

```bash
docker compose up --build
```

Open http://localhost:8080 and sign in:

| Role    | Email               | Password       | Can                                      |
|---------|---------------------|----------------|------------------------------------------|
| owner   | owner@example.com   | owner-pass     | everything, including money and the clock |
| support | support@example.com | support-pass   | customers, servers, IPs; no money         |
| viewer  | viewer@example.com  | viewer-pass    | read only                                 |

On first start the database is migrated and seeded with four customers and five servers.
The servers go through the real pipeline, so you can watch them move from `pending` to
`running` while the fake infrastructure fails 20% of calls and lies on 10%.

Services: `db` (PostgreSQL 17), `infra` (fake infrastructure, port 4001 inside the network),
`api` (API, background workers and the built admin panel, published on 8080).

## Tests

With Docker only:

```bash
docker compose --profile test run --build --rm test
```

Locally (Node 24, PostgreSQL 14+ with `btree_gist`, which ships with PostgreSQL):

```bash
npm ci
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

Each API test file creates and drops its own database. 55 tests:

| Suite | What it proves |
|---|---|
| `apps/api/test/billing.test.ts` | exactly-once billing with two concurrent runs and with a crash halfway; downtime; one bad record; price change; IP paid by the first holder of an hour |
| `apps/api/test/ip.test.ts` | one IP, one payer: simultaneous moves, overlap refused by the database, moves racing a termination, restore |
| `apps/api/test/workers.test.ts` | the infrastructure lies: adopt instead of duplicate, confirmed deletes, orphan/duplicate/late-create clean-up, seeded random chaos |
| `apps/api/test/db.test.ts` | the API survives the database dropping idle connections |
| `apps/api/test/http.test.ts` | roles enforced by the server, strict input, retry-safe top-ups and creates, append-only ledger, forward-only clock, asset serving |
| `apps/web/test/stale-search.test.tsx` | stale search results never replace newer ones; URL state; loading / empty / failed |
| `apps/infra/test/infra.test.ts` | the fake infrastructure is slow, unreliable and dishonest |

## Demo

1. **Servers**: the seeded servers become `running`. Under Operations, "Infrastructure drift" lists any server that was adopted after the infrastructure lied.
2. Search `acme` and tick `running`. The filters are in the URL: reload, or copy the link.
3. **Operations**: click `+1 hour`, then `Run billing now` twice. The second run creates 0 charges.
4. Open a server and **Move…** its IP to another customer's server. The IP page (IP pool → address) shows who held it and that each hour has one payer.
5. Sign in as `support`: there is no top-up form, and `POST /api/customers/:id/topups` answers 403 anyway.
6. Operations → "Fake infrastructure behaviour": set "Calls that lie" to 50 and create servers on a customer page. Each still gets exactly one infrastructure server.
7. Terminate a server and **Restore** it: it gets its old IP back if nobody took it.

## How it works

```
apps/infra   fake infrastructure (Fastify, in-memory, injectable randomness)
apps/api     API + workers (Fastify, pg, raw SQL, zod)
  migrations/001_schema.sql   all tables and the rules below
  src/billing.ts              hourly billing
  src/servers.ts              create / terminate / restore, IP attach / release / move
  src/workers.ts              provisioning, polling, termination, reconciliation
  src/routes/*                HTTP endpoints, one permission each
apps/web     admin panel (React 19, React Router 7, Vite)
  src/lib/useLatestRequest.ts the stale-response guard
docs         diagrams, presentation, regression evidence
```

### Rules the database enforces

| # | Rule | How |
|---|---|---|
| R1 | the app clock only moves forward | trigger on `app_clock` |
| R2 | one open row per customer status, several statuses at once | partial unique index |
| R3 | an infrastructure server is tracked once | `servers.infra_id` unique |
| R4 | a retried create makes one server | unique `(customer_id, idempotency_key)` |
| R5 | a server never changes owner | trigger |
| R6 | a server's running periods never overlap | `EXCLUDE (server_id =, during &&)` |
| R7 | an IP's payer is the owner of its server | composite FK `(server_id, customer_id)` |
| R8 | an IP has one holder at any moment | `EXCLUDE (ip_id =, during &&)` |
| R9 | IPs attach only to alive servers | trigger, locks the server row `FOR SHARE` |
| R10 | the ledger is append-only | triggers on update, delete, truncate |
| R11 | a charge is one resource and one whole UTC hour | check constraints |
| R12 | a top-up key adds money once | partial unique index |
| R13/R14 | one charge per server-hour and per IP-hour | partial unique indexes |
| R15/R16 | a charge is refunded once, by its exact amount | unique index + trigger |

### Billing

Every UTC clock hour in which a resource was in use is charged once, at the price in effect
at the start of that hour ("any started hour counts"). A server is in use inside its
`server_usage` periods (from `running` until termination is requested). An IP is in use
while it is attached to a server that runs; if it changes hands within an hour, the first
holder in that hour pays it.

The job does not remember what it did. Each run recomputes every due hour from the usage
history and inserts the missing charges with `ON CONFLICT DO NOTHING` against R13/R14, one
transaction per resource. Concurrent runs, crashed runs and runs after downtime all end in
the same state, and a failing resource is recorded in `billing_failures` without stopping
the others. It runs every minute and on demand (Operations → Run billing now).

### Time

All billing reads `app_now()`, a database function over a single `app_clock` row. The clock
ticks with real time and can be moved forward (owner only) from Operations or with
`POST /api/clock/advance {"hours": 1}`. Tests freeze it at fixed dates.

### Talking to the unreliable infrastructure

An infrastructure error means "unknown outcome", never "did not happen". Our server id is
sent as the infrastructure tag; before creating, the worker looks the tag up, so a create
that failed after doing its work is adopted, not repeated. Deletes are confirmed with a
read. The reconciler (every 20 s) deletes infrastructure servers nobody tracks, adopts ones
we lost track of, and stops billing servers that vanished. It does nothing if the listing fails.

## Configuration

| Variable | Service | Default |
|---|---|---|
| `INFRA_FAIL_RATE`, `INFRA_LIE_RATE` | infra | 0.2, 0.1 |
| `INFRA_PROVISION_MS`, `INFRA_LATENCY_MS` | infra | 3000, 200 (Compose: 4000, 300) |
| `DATABASE_URL`, `INFRA_URL`, `WEB_DIST`, `PORT` | api | see `docker-compose.yml` |
| `BILLING_EVERY_MS`, `RECONCILE_EVERY_MS` | api | 60000, 30000 (Compose: 60000, 20000) |
| `WORKERS` | api | `on` |

## Development

```bash
npm ci
# terminal 1: fake infrastructure
node apps/infra/src/main.ts
# terminal 2: API and workers (needs PostgreSQL)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/billing node apps/api/src/main.ts
# terminal 3: admin panel with hot reload on http://localhost:5173 (proxies /api to :4000)
npm run dev -w apps/web
```

Node 24 runs the TypeScript sources directly (type stripping), so the backend has no build step.
`npm run typecheck` checks all three packages.

### Diagrams and presentation

The diagrams are Mermaid files in `docs/diagrams`; GitHub renders them, and any editor with
Mermaid support can preview them. The PDF is generated from them:

```bash
node docs/presentation/build.mjs   # needs Edge or Chrome; set BROWSER=/path/to/browser otherwise
```

`npm audit` reports `katex`, a dependency of `mermaid`, which is only used to build the PDF.
It is a dev dependency and is not installed in the runtime image (`npm ci --omit=dev`).

## Not built, and known limits

The optional "running out of money" flow is not built: balances can go negative and nothing
notifies or suspends automatically (staff can set statuses by hand, and suspension blocks new
servers). Other limits and what I would do next are on the "What is not safe yet" slide.
