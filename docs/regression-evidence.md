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
