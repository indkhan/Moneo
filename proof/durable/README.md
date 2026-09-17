# E00-S04 durable-effects proof

Feasibility proof, not production job infrastructure. One synthetic command
(an idempotent unit-counter increment) is durably accepted and applied once
despite retry, process death, stale attempts and complete Redis transport
loss, using the transaction boundaries that E02-S01/S02 will productionize.

## Run

Prerequisites (local, disposable — never shared/prod services):

- PostgreSQL 18 reachable at `DATABASE_URL` (app role), plus a
  CREATEDB-capable `DATABASE_MIGRATION_URL` used once to create the
  disposable `moneo_durable_proof` database (override with
  `DURABLE_PROOF_DB`). All proof runtime I/O uses the app role.
- A local Redis 7+ reachable at `REDIS_URL` (loopback only; the suite
  refuses non-local hosts). The suite owns one logical DB
  (`DURABLE_PROOF_REDIS_DB`, default 15) and flushes only that DB.

```powershell
npm ci
npm run typecheck
npm run test:durable
```

`npm test` (the default harness) stays service-free; this suite fails closed
when PG/Redis are missing instead of skipping. On this machine Redis runs in
WSL Ubuntu 24.04 (`redis-server`, systemd unit, enabled) and WSL stops
shortly after its last client session ends, so hold one session for the run,
e.g. `wsl -d Ubuntu-24.04 -u root sleep 900` in a second terminal.

## Chosen dependencies

- `bullmq@6.3.6` — the architecture's locked R1 execution transport; real
  `Queue`/`Worker` over real Redis, deterministic job keys
  (`e00s04-<operationId>`), minimal reference-only payloads
  (`{operationId, tenantId}`), short completed/failed retention.
- `ioredis@5.11.1` — BullMQ 6's supported client line (matches its own
  pinned dev dependency); separate connections per Queue/Worker,
  `maxRetriesPerRequest: null` for blocking worker commands.
- `pg@8.23.0` (+ `@types/pg@8.23.1`) — direct SQL for the outbox
  (`FOR UPDATE SKIP LOCKED`), the generation-fenced claim and the
  compare-and-swap publish. No ORM, no mocked transactions or leases.

Rejected: stronger Redis (unneeded; BullMQ needs >= 6.2), a second queue
topology, BullMQ Flows (PG workflow state is the durable graph per §194).

## Protocol (mirrors architecture sections 186-189, 195, 197)

1. `acceptCommand` inserts command + outbox + job rows in one transaction.
   Same identity + same payload hash returns the existing command
   (concurrent winners converge via PK + re-read); same identity with a
   different payload or tenant is rejected (`INCOMPATIBLE_REUSE`,
   `TENANT_MISMATCH`).
2. `dispatchOutbox` claims due outbox rows `SKIP LOCKED`, enqueues by
   deterministic job key (dying between enqueue and marking only causes a
   deduped re-enqueue), then marks published. Cancelled jobs are consumed
   without ever touching the transport.
3. `claimAttempt` moves `QUEUED` (or lease-expired `RUNNING`) to `RUNNING`
   under a row lock while raising monotonic `attempt_generation`.
4. `publishEffect` commits effect row + counter increment + `SUCCEEDED` only
   when generation still matches, state is `RUNNING` and no cancel won; the
   `proof_effects(operation_id)` PK is a second backstop. Losers are recorded
   `STALE` (superseded) or `BLOCKED` (cancelled); unknown/forged identities
   answer `STALE_ATTEMPT` without disclosing existence.
5. `reconcile` rebuilds transport purely from PG: unpublished outbox,
   published-but-unstarted jobs, lease-expired `RUNNING` jobs. Queue job
   status is never consulted.

## Fault coverage (each a runnable test in `test/durable.test.ts`)

Worker death is simulated by omitting the next protocol step at each
persisted boundary (accept → dispatch → claim → publish); PG transaction
atomicity is what makes the omitted step safe to replay. No live SIGKILL
mid-handler is performed in this proof — E02-S02 should add one.

- 20 concurrent identical submissions + duplicate dispatch → one effect.
- Crash before dispatch / after enqueue-before-marking / during execution /
  after effect commit → no loss, no duplicate on recovery.
- `FLUSHDB` of the dedicated Redis DB → reconciler restores 5/5.
- Stale generation publish fenced; cancel after claim blocks publication;
  cancel after success preserves history; cross-tenant claim/publish denied.
- Second synthetic tenant runs throughout; counters never cross.

## Test-only limits (not production policy)

- PG claim lease 300–500 ms in fault tests, 5 s under the live worker;
  reconciler invoked explicitly (no background poller in the proof).
- Mass recovery: 100 stalled commands reclaimed and drained in ≈190–270 ms
  (204/191/253/268 ms across four runs) against a 30 s budget (Windows 11,
  i5-12450HX, 16 GiB RAM, PostgreSQL 18.6, Redis 7.0.15, BullMQ 6.3.6,
  Node v22.23.2).
- Heartbeats: there is no periodic heartbeat in the proof and no
  BullMQ-competing transport lock (§199); attempt started/completed
  timestamps are the only liveness record. Production lease/heartbeat/
  reconcile values will be set with real workload measurements in E02-S02.

## Decision carried forward

Keep PG-outbox + BullMQ-transport + attempt-generation fencing as the
E02-S01/S02 boundary. A queue-only happy-path demo would not have passed:
the proof required the reconciler and the stale-attempt fence to earn it.
