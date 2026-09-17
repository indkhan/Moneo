# E00-S05 decision/evidence report — identity, deployment identity, development AI

Status: **Pass** for the revised R1 decision. A pinned disposable Keycloak 26.7.4 container proved login, refresh and provider-side session revocation; hardened Docker containers proved per-service synthetic-secret isolation; the OpenRouter development-model live gate passed using synthetic inputs. No secret values, tokens or response bodies were logged.

Founder decision on 2026-09-17 replaced Auth0 and Render/AWS with self-hosted Keycloak and Docker-hosted services for R1. The architecture override records production gates; this proof uses Keycloak `start-dev` only as a disposable feasibility fixture.

## Vendor documentation verified live (2026-09-17)

| Claim used | Source (checked 2026-09-17) | What it confirms |
|---|---|---|
| Keycloak 26.7.4 official container supports Docker and realm import; `start-dev` is development-only | https://www.keycloak.org/server/containers | Pinned disposable identity proof and explicit production exclusion |
| Keycloak exposes OIDC and Admin REST APIs for application login and session administration | https://www.keycloak.org/docs-api/latest/rest-api/index.html | Live token, refresh and user-session logout proof |
| Docker grants Compose secrets only to explicitly listed services | https://docs.docker.com/compose/how-tos/use-secrets/ | Per-service secret boundary carried into E01 deployment |
| Per-request `provider.zdr:true`; per-model-group enforcement; unknown endpoints conservatively marked retain+train; ZDR ≠ residency; plugins excluded; OpenRouter itself ZDR unless logging opted in | https://openrouter.ai/docs/guides/features/zdr | §130 production route shape |
| `:free` suffix variant; availability/rate limits differ from paid | https://openrouter.ai/docs/guides/routing/model-variants/free | Free models are replaceable smoke, never production qualification |
| Free caps 20 req/min, 50/1000 req/day; 401/402/403/404/408/429/5xx semantics; 429 → backoff + honor Retry-After; negative balance → 402 even on free models | https://openrouter.ai/docs/api_reference/limits | Probe error taxonomy + budget |
| 20 `:free` variants listed; `liquid/lfm-2.5-2.6b:free` advertises `tools`+`structured_outputs` | `GET https://openrouter.ai/api/v1/models` (2 catalog reads, not inference) | Explicit dev-model selection below |

## Selected development model

`liquid/lfm-2.5-2.6b:free` (selected 2026-09-17, ctx 64k). Free-tier limits: 20 req/min; 50/day (<10 credits) or 1000/day (≥10). Training/retention: **development-only training-permitted route, synthetic fixtures only** — never founder/customer data. Production requires separately qualified no-training/ZDR routes with no downgrade fallback (`proof/identity/policy.ts`). If this free model fails or disappears, replace it; never weaken validation.

## What is proven (deterministic, `npm run test:identity`)

- Dev allows training-permitted free routes; production denies them, non-ZDR routes, content-logged routes, and unqualified free routes; failed primaries return recoverable unavailability, never a privacy downgrade (`policy.ts`).
- App-session revocation denies even with live SSO (copied-cookie case); SSO logout alone leaves an issued app cookie valid — so E01-S02 must revoke locally first (`session-layers.ts`).
- A disposable Keycloak realm issues and refreshes a synthetic user session; Admin REST logout makes the prior refresh token fail. The container and temporary realm credentials are removed after every run (`npm run test:identity:docker`).
- Docker proof services run with numeric non-root UID 65532, read-only root filesystems, all capabilities dropped, no-new-privileges and no network. Only the explicitly mounted service reads the synthetic secret; an ungranted peer cannot see it.
- Tool allowlist + strict decimal-string money args, malformed-output rejection, 401/402/403/404 vs retryable 429/408/5xx/timeout taxonomy, one-retry cap, and the hard 20-request budget (`openrouter-probe.ts`, mock transports).

## Live OpenRouter result

`OPENROUTER_API_KEY` from the ignored local environment ran three bounded synthetic requests: tool selection and strict structured output returned 200 and validated; a bogus model was rejected once with HTTP 400 and no retry or fallback. The deterministic taxonomy treats 400 as non-retryable `invalid-request` while retaining 404 as non-retryable `unavailable-model`.

## Remaining risks

- Free-model availability/quality rotates; production qualification is deferred to E08-S03 and must re-run the evaluation rubric on pinned no-training/ZDR routes.
- Production Keycloak still needs PostgreSQL persistence, TLS/hostname configuration, strong-factor/passkey qualification, upgrades, backup/restore and restricted administration before external users.
- Docker secrets are host-mounted files, not a cloud KMS. Host hardening, encrypted secret provisioning and production network placement remain deployment gates.

## Cleanup

The Keycloak container, realm file and generated credentials were removed after the proof. Hardened service containers used `--rm`; no proof container remains. The earlier Auth0 attempt created no user. OpenRouter received synthetic prompts only.
