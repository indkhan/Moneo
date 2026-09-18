# Moneo

R1 starts with a minimal TypeScript/Vitest harness for synthetic feasibility proofs. It does not require production credentials, customer data, or model requests.

## Prerequisites

- Node.js 22.23.2 (the supported range is Node 22.x; `.node-version` pins the tested version)
- npm 10.9.8

## Setup and checks

From a fresh checkout:

```powershell
npm ci
npm run typecheck
npm test
```

Run `npm run check` for typechecking and the normal test suite together. `npm run test:failure` intentionally fails and must exit nonzero; it is separate from the normal suite.

The E00-S02 browser proof is documented in [`proof/artifact/README.md`](proof/artifact/README.md). Install its pinned browser builds once with `npm run test:artifact:install`, then run `npm run test:artifact`.

The E00-S03 import-fidelity proof is documented in [`proof/import/README.md`](proof/import/README.md). Its golden fixtures and hand-specified expectations live in `proof/import/fixtures/`; run it with `npm run test:import`. Hostile and resource-bound cases execute inside a disposable bounded child process.

The E00-S05 identity proof is decided in [`proof/identity/REPORT.md`](proof/identity/REPORT.md). Its deterministic checks run offline with `npm run test:identity`; the opt-in live gates (skipped without credentials, never part of CI) run with `npm run probe:identity`.
The revised Docker/Keycloak gate runs with `npm run test:identity:docker`; it
creates only disposable synthetic identities and removes its containers and
temporary credential files after the run.

The E00-S04 durable-effects proof is documented in [`proof/durable/README.md`](proof/durable/README.md). It needs local PostgreSQL and a local Redis 7+ (see that README for the disposable database/DB convention); run it with `npm run test:durable`. It fails closed when either service is missing.

## E02 ingestion slice (uploads)

Quarantine uploads need three local prerequisites besides PostgreSQL/Redis,
all synthetic-only and fail-closed when absent:

```powershell
# 1. S3-compatible object storage (pinned test image, loopback, disposable):
docker run -d --name moneo-minio -p 127.0.0.1:9000:9000 `
  -e MINIO_ROOT_USER=moneo-test-only -e MINIO_ROOT_PASSWORD=moneo-test-only-secret-01 `
  quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e server /data
# 2. Malware scanner (pinned test image, loopback, disposable; first boot
#    downloads signature databases and takes a few minutes):
docker run -d --name moneo-clamav -p 127.0.0.1:3310:3310 `
  clamav/clamav:stable@sha256:9cb27d7660bdf66e9878c832cb433dd8aa152cfbe16f3c2c0084c80b04ae22b4
# 3. Local env (names only here; values stay in the ignored .env):
#    UPLOADS_ENABLED=1 S3_ENDPOINT=http://127.0.0.1:9000 S3_REGION=us-east-1
#    S3_ACCESS_KEY=<synthetic> S3_SECRET_KEY=<synthetic> S3_BUCKET=<test bucket>
#    CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=3310
npm run build:parser   # compiles the worker-spawned bounded parser child
npm run test:upload    # real PG + MinIO + clamd integration
```

Uploads stay disabled unless `UPLOADS_ENABLED=1` with all S3/scanner inputs
present; the intake endpoint hides as 404 otherwise. Scanned bytes never
leave the loopback scanner; quarantined bytes stay in the private bucket
prefix under generated keys and are never served back.

## E01 application slice

Copy `.env.example` to `.env` (ignored by Git) for machine-local synthetic
settings; never commit real values. Then:

```powershell
npm ci
npm run typecheck
npm run test:web
npm run build:web
npm run start:web   # serves http://127.0.0.1:3000/healthz
```

`GET /healthz`, `/readyz` and `/version` report only build metadata
(release/gitSha); they never echo request data or environment secrets.
`/readyz` additionally reflects database reachability when configured.

## Web shell and operational controls

With identity configured, the same server renders a zero-JavaScript HTML
shell: `GET /` lists workspaces, `GET /w/:id` shows accounts with rename
forms (backed by the idempotent command) and AI-exclusion toggles (backed
by the policy gate). Every request gets a server-generated `X-Request-Id`
that also appears in error pages; request logs carry only
id/method/path/status/ms. Mutating/auth routes are rate-limited per client
IP and the server caps in-flight requests; `/readyz` fails when the
database is unreachable. Run the shell suite with `npm run test:ui`.
Required CI is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
and runs the same deterministic gates plus a staging image smoke. Run the
synthetic staging smoke locally with `npm run staging:smoke` (needs Docker;
builds `moneo-web:staging-candidate`, probes `/healthz` as non-root
read-only, promotes to `staging-current` and re-serves the prior tag as the
rollback demonstration). Compose staging is declared in [`compose.yml`](compose.yml).

Proofs should keep committed synthetic fixtures beside their tests and write disposable reports, screenshots, and measurements under the ignored `proof-output/` directory. Later stories add browser or service dependencies only when their proof consumes them.
