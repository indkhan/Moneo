# E08-S02-L operator restore runbook (local/disposable drill)

Synthetic data only. This runbook governs the local restore drill proven by
`npm run test:restore`. Production recovery (provider PITR, managed state,
real credentials) is E08-S02-D and needs its own owner/alert/credentials
handling before any customer data exists.

## Roles

- Owner: repository operator running the drill (no customer data locally).
- Alert: none configured locally; the drill fails loudly (nonzero exit) and
  the deployed alert is an S02-D item.

## Restore point

- Source: `pg_dump -Fc` of the live database plus a MinIO object snapshot
  (`snapshotWorkspaceObjects`). Record the dump timestamp as T0 (ISO-8601)
  BEFORE the dump starts: tombstones created during the dump window are
  then replayed rather than risked as already-included-and-skipped.
- Tombstone ledger: read `deletion_tombstones` from the LIVE database
  before touching anything. It lives outside restored tenant data by design.

## Isolated restore (never into live)

1. Create a FRESH database (never reuse the live name).
2. Provision it like live drill databases: `ALTER DATABASE <fresh> OWNER
   TO <app_role>` and `GRANT CREATE ON SCHEMA public TO <app_role>`
   (PostgreSQL 15+ withholds public-schema create by default), then
   `pg_restore --clean --if-exists --no-owner --role <app_role> -d
   <fresh> <T0 dump>` so restored objects keep application ownership.
   A nonzero exit stops the drill: the target stays untouched and no
   traffic moves. Corrupted/truncated dumps fail here by design.
3. Restore objects under test prefixes only; byte-compare every file.
4. Replay tombstones with `deleted_at > T0` into the fresh database
   (`replayTombstones`): resurrected workspaces re-purge with their objects;
   resurrected memberships/sessions/personal content re-purge; anonymization
   applies only with zero memberships anywhere.
5. Re-verify evidence hashes (`hashWorkspaceEvidence` vs pre-failure):
   every section must match exactly or traffic stays closed.
6. Re-run migrations (must be a no-op) and boot the app against the fresh
   database for a tenant-read smoke test.

## Traffic gate

There is no automatic switch. Traffic reopens only after steps 2–6 pass on
the isolated database AND a founder decision (external beta) or the S02-D
provider drill (production). The drill database is then discarded; it never
becomes the live one by rename.

## Rollback

- Drill rollback: drop the fresh database and delete the snapshot
  directory. No production state exists locally to roll back.
- Deploy rollback (code): redeploy the prior image; migrations are
  additive and re-runnable (`migrate` is idempotent).

## Keycloak recovery

Local drill scope: Keycloak runs as a disposable container with synthetic
identities; realm recovery is re-provisioning, not data restore. Production
Keycloak needs persistent PostgreSQL, realm export backups and a tested
import drill — S02-D gate, explicitly not claimed here.

## External identity after replay

`replayTombstones` reports `needsExternalIdentity` (Keycloak subs whose
local identity was anonymized). The operator deletes those IdP identities
through the deployed admin path (S02/S04 gate); the drill's recording
stand-in is not a production deletion.
