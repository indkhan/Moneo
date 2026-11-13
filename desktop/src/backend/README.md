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
| `run/services.json` | PID and executable of each running service, so a start after a crash can end leftovers |

## After a crash or force-quit

- `pg_ctl` starts Postgres outside the app's process tree, so it keeps running. At the next start,
  a `postmaster.pid` whose PID is alive and is a `postgres` executable from this bundle (or one whose
  command line names this data folder) is stopped with `pg_ctl stop -m fast`; any other PID there means
  the file is stale and it is deleted.
- GoTrue and PostgREST: on Windows they end with the app (libuv puts children in a kill-on-close job);
  elsewhere they may survive. At the next start each PID in `run/services.json` is ended only if it is
  alive, its executable is the recorded one and lies inside the bundled backend. Nothing is matched by
  name, and a PID now used by another program is left alone.
- The Storage server exits by itself within a second once the process that started it is gone
  (`MONEO_PARENT_PID`, checked by a few lines fetch-backend.mjs puts at the top of its bundle).

## Start order

1. Postgres (`initdb` on first run, otherwise the recovery above), via `pg_ctl`.
2. First run only: `desktop/bootstrap/*.sql` as `supabase_admin`, then the passwords and JWT settings
   `docker/db/roles.sql` sets.
3. Refuses to go on if the database has a migration newer than the bundled ones. With pending
   migrations (or other bundled service versions) on an existing database: an automatic
   `pre-upgrade` backup (the newest 5 automatic backups are kept).
4. GoTrue (runs its migrations), Storage API (runs its migrations), PostgREST, gateway.
5. `supabase/migrations` exactly like `scripts/setup.mjs` (same `supabase_migrations.schema_migrations`,
   one transaction per file, `notify pgrst`), then the owner through the GoTrue admin API.

## Differences from the Docker backend

- **safeupdate** is compiled from pinned upstream source against each bundled PostgreSQL and
  preloaded for `authenticator`, preserving rejection of unfiltered PostgREST updates and deletes.
  Building needs Visual Studio C++ Build Tools on Windows and a C compiler on macOS/Linux.
- **No supautils, pg_graphql, pg_net, pg_cron, pgsodium/vault, pg_stat_statements, realtime.**
  Moneo does not call these extensions; the supautils migration grants are reproduced below.
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
- **Storage API is one esbuild bundle** (`storage-api/server.js` plus pino's three worker files,
  `migrations/`, `THIRD_PARTY_NOTICES.txt`), about 16 MB instead of a 340 MB `node_modules` with paths
  over 260 characters. It runs with `EXPOSE_DOCS=false` (Swagger docs need its package.json).
- **MSVC runtime on Windows.** The Windows PostgreSQL build needs `vcruntime140.dll`,
  `vcruntime140_1.dll` and `msvcp140.dll`. They ship app-local in `postgres/bin` and `postgrest/`
  (Windows loads them from the executable's folder first), taken from Microsoft's signed
  VC_redist.x64 14.44.35211.0 and pinned by SHA-256 in `fetch-backend.mjs`, so no vc_redist install is
  needed.
- **GoTrue keeps a connection pool** (`GOTRUE_DB_MAX_IDLE_POOL_SIZE`). Its default keeps none, and on
  Windows each new Postgres connection starts a process (100+ ms), which made every page's sign-in
  check take about half a second.
- Postgres settings follow the image where they change results (`timezone = UTC`,
  `extra_float_digits = 0`, `row_security = on`, english text search); `jit = off`, no replication
  (`wal_level` default), logs rotate daily for a week.
