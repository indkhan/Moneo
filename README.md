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

Proofs should keep committed synthetic fixtures beside their tests and write disposable reports, screenshots, and measurements under the ignored `proof-output/` directory. Later stories add browser or service dependencies only when their proof consumes them.
