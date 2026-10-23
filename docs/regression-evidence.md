# Regression evidence

The task asks for at least one regression test that was seen failing without the fix.

## Exactly-once billing under concurrency

Test: `apps/api/test/billing.test.ts` → "two billing runs at the same moment charge each hour exactly once".

Experiment (2026-10-23): the protection was replaced by the naive approach that most first
versions use, "check, then insert":

- the unique indexes `ledger_server_hour_once` and `ledger_ip_hour_once` were removed from the schema;
- the billing inserts used `... and not exists (select 1 from ledger_entries where same resource and hour)`
  instead of `on conflict ... do nothing`.

Result of the test against that version:

```
× two billing runs at the same moment charge each hour exactly once
AssertionError: expected 280 to be 150
```

Both runs read "not billed yet" before either committed, so 130 hours were charged twice.
With the unique indexes and `on conflict do nothing` restored, the same test passes. The
second run's insert of an already-inserted row waits for the first transaction and then
skips it, so the database guarantees exactly-once.

## One IP, one payer without the application lock

Test: `apps/api/test/ip.test.ts` → "two simultaneous moves of one IP: exactly one succeeds".

Experiment (2026-10-23): the `for update` on the IP row in `moveIp` was removed. The test
still passed: in every round one move succeeded and the other failed with `23P01`
(exclusion violation) from the `ip_assignments` constraint. The rule holds in the database
even when the application code gets it wrong.

## Stale search results

Tests: `apps/web/test/stale-search.test.tsx` → "ignores an older answer that arrives after a
newer one, even if the abort is ignored" and "a slow answer for an older search never
replaces the newer results".

Experiment (2026-10-23): the sequence check `if (id === latest.current)` in
`useLatestRequest` was removed, keeping only the AbortController. Both tests failed:

```
× ignores an older answer that arrives after a newer one, even if the abort is ignored
× a slow answer for an older search never replaces the newer results
```

Aborting alone is not enough: the mocked server (like a real one) can answer anyway, and a
response already received cannot be cancelled. With the check restored both tests pass.

## Missing asset answered with HTML (found while testing the UI)

Test: `apps/api/test/http.test.ts` → "deep links get the app, a missing asset is a 404 and never HTML".

Found by hand: after rebuilding the web app while the API was running, the page went blank
with "Expected a JavaScript module script but the server responded with text/html". The
static plugin only knew the files that existed at start, and the single-page-app fallback
answered the new bundle's URL with `index.html`. The same happens to a browser tab that is
still open after a deploy. The test failed on the old `app.ts`
(`expected 'text/html; charset=utf-8' to match /javascript/`) and passes after the fix:
files are looked up per request and paths with a file extension get a real 404.

## Idle database connections dropped by the server (found by running the tests in Docker)

Test: `apps/api/test/db.test.ts` → "survives the server terminating idle connections, and reconnects".

Found by the Docker test run: all 44 tests passed but the run exited with an error, because
a pooled connection received a FATAL 57P01 from Postgres and nothing listened for the
pool's `error` event, which node turns into an uncaught exception. In production the same
thing would crash the API on every Postgres restart or failover. The new test failed before
the fix with 5 unhandled errors and passes after adding `pool.on('error', ...)` in `createPool`.

## Healthcheck used localhost (found by starting the stack in Docker)

The api container stayed `health: starting` although the API worked: inside the Alpine image
`localhost` resolves to ::1 while the API listens on IPv4. The healthcheck now uses 127.0.0.1.
