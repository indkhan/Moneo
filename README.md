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

Proofs should keep committed synthetic fixtures beside their tests and write disposable reports, screenshots, and measurements under the ignored `proof-output/` directory. Later stories add browser or service dependencies only when their proof consumes them.
