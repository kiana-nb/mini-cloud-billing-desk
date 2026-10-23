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
