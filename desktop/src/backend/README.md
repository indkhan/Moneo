# Moneo Desktop native backend

`index.ts` replaces `docker-compose.yml` inside the desktop app: PostgreSQL, GoTrue, PostgREST and the
Storage API run as child processes on `127.0.0.1`, behind a small gateway with the same three paths as
`docker/Caddyfile`. The binaries come from `node scripts/desktop/fetch-backend.mjs` (pinned versions and
SHA-256 in that script), and land in `desktop/.build/` (in a package, `resources/`).

## Home folder

| Path | What |
| --- | --- |
| `config.json` (0600) | generated secrets (same generation as `scripts/setup.mjs`), preferred ports, setup state |
| `postgres/` | the cluster (`initdb -U supabase_admin`, UTF8, ICU en-US, scram-sha-256) |
| `storage/` | Storage API files |
| `data/`, `workflow/` | `MONEO_DATA_DIR`, `WORKFLOW_LOCAL_DATA_DIR` for the app |
| `backups/<time>-<reason>/` | `database.dump` (pg_dump -Fc), `storage/`, `config.json`, `manifest.json` |
| `logs/` | `backend.log`, `auth.log`, `rest.log`, `storage.log`, `postgres/` |
| `run/services.json` | PIDs of running services, so a start after a crash can end leftovers |

## Start order

1. Postgres (`initdb` on first run, otherwise stale `postmaster.pid` recovery), via `pg_ctl`.
2. First run only: `desktop/bootstrap/*.sql` as `supabase_admin`, then the passwords and JWT settings
   `docker/db/roles.sql` sets.
3. Refuses to go on if the database has a migration newer than the bundled ones. With pending
   migrations (or other bundled service versions) on an existing database: an automatic
   `pre-upgrade` backup (the newest 5 automatic backups are kept).
4. GoTrue (runs its migrations), Storage API (runs its migrations), PostgREST, gateway.
5. `supabase/migrations` exactly like `scripts/setup.mjs` (same `supabase_migrations.schema_migrations`,
   one transaction per file, `notify pgrst`), then the owner through the GoTrue admin API.

## Differences from the Docker backend

- **No supautils, safeupdate, pg_graphql, pg_net, pg_cron, pgsodium/vault, pg_stat_statements,
  realtime.** Nothing in Moneo uses them. `authenticator` therefore has no
  `session_preload_libraries`; without safeupdate, a PostgREST `DELETE`/`UPDATE` with no filter is not
  rejected (RLS still limits it to the owner's rows).
- **supautils' policy grants.** In the image, supautils lets `postgres` create and drop policies and
  triggers on `auth.*`/`storage.*` tables it does not own. Moneo's migrations need that
  (`create policy … on storage.objects`). During Moneo's own migrations only, `postgres` is granted
  `supabase_auth_admin` and `supabase_storage_admin` (`inherit true, set false`); the grant is revoked
  right after, and at every start in case a crash interrupted it. `postgres` otherwise keeps the
  image's attributes: `NOSUPERUSER BYPASSRLS`.
- **uuid-ossp** is created only where the bundled PostgreSQL has it (not in the Windows build).
- **Storage metadata on Windows.** Storage keeps content type, cache control and etag in extended
  attributes through the native `fs-xattr`, which does not exist on Windows. The bundled Storage uses
  `scripts/desktop/backend-fs-xattr-shim`: NTFS alternate data streams on Windows, the upstream
  N-API addon on macOS and Linux.
- **GoTrue on Windows** is built with a `go build -overlay` that drops one `SO_REUSEPORT` call
  (no such option on Windows); see `fetch-backend.mjs`.
- Postgres settings follow the image where they change results (`timezone = UTC`,
  `extra_float_digits = 0`, `row_security = on`, english text search); `jit = off`, no replication
  (`wal_level` default), logs rotate daily for a week.
