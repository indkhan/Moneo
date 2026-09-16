# E00-S05 decision/evidence report — identity, deployment identity, development AI

Status: deterministic proof passes offline; all three live gates honestly **Blocked** (no credentials in this environment). No live results invented, no production paths touched.

## Vendor documentation verified live (2026-09-17)

| Claim used | Source (checked 2026-09-17) | What it confirms |
|---|---|---|
| 3 separate session layers; app logout clears the app session, SSO logout is a redirect to the logout endpoint, federated logout optional | https://auth0.com/docs/manage-users/sessions/session-layers | Arch §426: SSO revocation alone does not invalidate an issued app cookie — revoke locally first |
| Free $0/25k MAU incl. passkeys, passwordless, 1 custom domain; Pro/Enterprise MFA **not** on Free; OIDC back-channel logout, long-lived sessions, continuous session protection are Enterprise-only | https://auth0.com/pricing | Plan/entitlement decision needed before E01-S02; Free tier cannot supply Enterprise session APIs |
| Managed OIDC requires **Pro workspace or higher**; AWS flow = IAM provider `oidc.render.com/{WORKSPACE_ID}` (aud `sts.amazonaws.com`) + per-service role via `AWS_ROLE_ARN`, one role per service | https://render.com/docs/oidc | Arch §370 path is real but plan-gated; no static-key fallback |
| Per-request `provider.zdr:true`; per-model-group enforcement; unknown endpoints conservatively marked retain+train; ZDR ≠ residency; plugins excluded; OpenRouter itself ZDR unless logging opted in | https://openrouter.ai/docs/guides/features/zdr | §130 production route shape |
| `:free` suffix variant; availability/rate limits differ from paid | https://openrouter.ai/docs/guides/routing/model-variants/free | Free models are replaceable smoke, never production qualification |
| Free caps 20 req/min, 50/1000 req/day; 401/402/403/404/408/429/5xx semantics; 429 → backoff + honor Retry-After; negative balance → 402 even on free models | https://openrouter.ai/docs/api_reference/limits | Probe error taxonomy + budget |
| 20 `:free` variants listed; `liquid/lfm-2.5-2.6b:free` advertises `tools`+`structured_outputs` | `GET https://openrouter.ai/api/v1/models` (2 catalog reads, not inference) | Explicit dev-model selection below |

## Selected development model

`liquid/lfm-2.5-2.6b:free` (selected 2026-09-17, ctx 64k). Free-tier limits: 20 req/min; 50/day (<10 credits) or 1000/day (≥10). Training/retention: **development-only training-permitted route, synthetic fixtures only** — never founder/customer data. Production requires separately qualified no-training/ZDR routes with no downgrade fallback (`proof/identity/policy.ts`). If this free model fails or disappears, replace it; never weaken validation.

## What is proven (deterministic, `npm run test:identity`)

- Dev allows training-permitted free routes; production denies them, non-ZDR routes, content-logged routes, and unqualified free routes; failed primaries return recoverable unavailability, never a privacy downgrade (`policy.ts`).
- App-session revocation denies even with live SSO (copied-cookie case); SSO logout alone leaves an issued app cookie valid — so E01-S02 must revoke locally first (`session-layers.ts`).
- Render OIDC readiness gate pins the Pro plan, workspace ID, IAM provider/trust, and one least-privilege role per service; static keys refused as fallback (`render-oidc.ts`).
- Tool allowlist + strict decimal-string money args, malformed-output rejection, 401/402/403/404 vs retryable 429/408/5xx/timeout taxonomy, one-retry cap, and the hard 20-request budget (`openrouter-probe.ts`, mock transports).

## What is Blocked (one smallest input per gate)

1. **Auth0 live** — founder supplies test-tenant `AUTH0_TEST_DOMAIN` + `AUTH0_TEST_CLIENT_ID`/`AUTH0_TEST_CLIENT_SECRET` + authorized test `AUTH0_TEST_USERNAME`/`AUTH0_TEST_PASSWORD` (process env shows all five absent). Then `npm run probe:identity` runs login + logout-endpoint reachability; stale-session denial lands in E01-S02. Smallest question: *which Auth0 plan (Free vs Essentials+) funds the tenant, given MFA/back-channel logout gating above?*
2. **Render OIDC live** — founder supplies Render workspace ID (`tea-…`, Pro plan or higher) + AWS IAM OIDC provider/role with the role ARN in the service `AWS_ROLE_ARN` variable (all absent). Then deploy one service and run `aws sts get-caller-identity` in its shell. Smallest question: *is the Render workspace on Pro (or higher), and what is its workspace ID?*
3. **OpenRouter live** — founder supplies `OPENROUTER_API_KEY` (development key, synthetic use only; absent). Then `npm run probe:identity` spends ≤5 inference requests (tool, structured-output, bogus-model 404) against the selected model within the 20-request cap. Smallest question: *which development OpenRouter API key may the probe use?*

Missing accounts/entitlements are explicit blockers; other E00 work may continue.

## Remaining risks

- Free-model availability/quality rotates; production qualification is deferred to E08-S03 and must re-run the evaluation rubric on pinned no-training/ZDR routes.
- Auth0 Free-tier session APIs are weaker (no back-channel logout/continuous protection); the E01-S02 design must assume app-side revocation as the enforcement point.
- Render OIDC stays untested until a Pro workspace + AWS role exist; the documented safe alternative is no deployment-identity story until then (never static keys).

## Cleanup

No live sessions, tenants, roles, keys, or objects were created (all live gates blocked before any request), so there is nothing disposable to delete and no shared resource was touched. Live probes create no objects when unblocked.
