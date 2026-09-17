# R1 story ledger

**Baseline:** 2026-09-16. All work is unstarted. Five E00 stories are Ready for their stated proof scope; the other 51 are Draft and require the [template](STORY-TEMPLATE.md) before assignment. Read [workflow](WORKFLOW.md) and [epic exits](EPICS.md). Dependencies listed here are required; do not infer readiness from wave placement alone.

Every story inherits: synthetic data until external-beta gates; no secrets or financial payloads in logs; tenant/policy enforcement at each trust boundary; exact decimal-string money across JSON; independently reviewed committed changes and tested integration before Done. Proofs are experiments, not authorization to expose an incomplete system to customers. All implementation evidence fields are empty until performed.

## E00-S01 — Establish an executable proof harness

Status: Done | Epic: E00 | Release: R1 | Dependencies: none

**Outcome:** A fresh checkout can execute a minimal synthetic check and host the four bounded feasibility proofs using documented commands.

**Contracts:** Architecture §§1–2, 490–494, 540; [delivery workflow](WORKFLOW.md). Inspect the actual repository and installed runtimes first. At planning time this repo contained planning documents and no application; do not assume package scripts or a remote exist.

**Scope:** If no Git history exists, initialize local main and commit the existing nonsecret planning baseline after inspecting staged filenames; keep `.env`, credentials, generated output and local caches out of Git. If history exists, preserve it. Select a supported current Node/package-manager combination, pin it and dependencies with a lockfile, and create the smallest TS test harness. Use Vitest for checks; add Playwright/browser assets only when S02 consumes them. Set up minimal local PG/Redis test prerequisites when S04 needs them. Choose one package manager, not several. Add a short root README with actual setup and commands. Reuse this harness for production work where appropriate.

**Out of scope:** Full Next application, production cloud provisioning, complete monorepo packages/schema, a custom orchestrator, remote repository creation without a supplied destination, customer data.

**Acceptance:**
1. A clean install using the lockfile, typecheck and a deliberately meaningful synthetic smoke check succeed from documented commands; a deliberate check failure produces nonzero exit.
2. A contributor can reproduce prerequisites and checks without any production secret or model request.
3. Git tracking/staged inspection confirms no `.env` or secret files. Existing work is preserved. If no remote exists, local branch/review evidence works and remote CI is explicitly pending E01-S01.
4. The root README records chosen versions, supported local setup, exact commands, and where proof outputs belong. No script is represented as tested unless run.

**Limits:** One test harness and only its consumed dependencies. One implementation/review cycle; split if application scaffolding starts to dominate. The four proofs get isolated folders only if needed; there is no framework for future proofs.

**Verification:** Execute install, typecheck, test and failure-exit check; record exact commands and exit codes. Inspect `git status`, tracked paths and diff. No live provider or paid deployment is required for this story.

**Review focus:** Secret inclusion, unnecessary scaffolding, unreproducible environment assumptions, tests that always pass. **Rollback:** Revert added harness files/commit without deleting user work or history.

**Execution record:** Orchestrator/implementer: Codex; branch: `story/e00-s01-proof-harness`; base/current-main SHA: `ee20bcd238acf80b114c1b1601e70e45e8b5e4e0`; implementation and candidate SHA: `70201d6d3788868bcdfc71748d18d8431426f165`. Independent reviewer verdict: Pass with no findings at `70201d6d3788868bcdfc71748d18d8431426f165`; reviewer reproduced `npm ci`, typecheck, normal/negative tests, diff/status and secret-path/signature checks. Candidate checks after `git fetch origin main`: `npm ci` 0, `npm run typecheck` 0, `npm test` 0 (1/1), `npm run test:failure` 1 as intended, `git diff --check` 0; current `main` and `origin/main` both matched the base SHA. Locally merged with `--no-ff` as `468f76a52fa307ffd635adccf48c2efde8b04152`; post-merge smoke: `npm ci` 0 (41 packages, 0 vulnerabilities), `npm run check` 0, `npm run test:failure` 1 as intended, clean status. No blockers; `.env` remained ignored/untracked and unread. Remote CI remains pending E01-S01; no remote push/PR was performed.

## E00-S02 — Prove the editable artifact security boundary

Status: Done | Epic: E00 | Release: R1 | Dependencies: E00-S01

**Outcome:** A hand-authored chart and scenario control run as supported HTML/CSS/JS inside the real proposed restriction mechanism, or evidence demonstrates the design needs revision.

**Contracts:** Architecture §§83–123, 416–489, 540; product Delivery baseline artifact commitment. Read these contracts in full before choosing a maintained VM wrapper, parser or sanitizer; record exact versions and why the smallest supported option fits.

**Scope:** Real QuickJS/WASM execution in a terminable worker; trusted renderer on a separate local site/origin with production-equivalent isolation/CSP; bundled VM assets; bounded render/message protocol; sanitized HTML/CSS subset; synthetic read-only Finance SDK; persisted sample state; compact/full views; one immutable version swap and failing migration rollback. The trusted host provides synthetic data. Exercise the actual build path without customer credentials. Use the smallest demonstrator rather than a browser/DOM emulation layer.

**Out of scope:** Full code editor, AI generation, cloud artifact storage, arbitrary modules/npm/browser APIs, general SDK breadth, real financial data.

**Acceptance:**
1. Chart and slider render, keyboard interaction works, reopening restores sample state, and compact/full modes remain usable.
2. Script cannot read host DOM/session/storage, fetch external URLs, load images/fonts/CSS URLs, navigate/open windows, access credentials or escape the approved SDK. Test forged messages and malformed HTML/CSS, not only benign examples.
3. Infinite loop, excessive allocation and message flooding are stopped; the trusted host remains interactive. Starting proof limits: 2 MiB source, 16 MiB VM heap, 1 MiB/message, 100 messages/second, 5-second execution ceiling, Stop acknowledged within 1 second. Record hardware/browser overhead; these are initial experiment limits, not production promises. Failed or infeasible limits require an explicit decision, not quiet removal.
4. Failed code build or incompatible state migration leaves the previous version/state usable; never publish half a version.
5. Pass relevant tests in Chromium, Firefox and WebKit using documented versions. Record any difference between automation and actual supported-browser deployment; a skipped browser is not a proof pass.

**Verification:** Add runnable browser checks to the harness; capture CSP violations and hostile test results without sensitive data. Inspect bundle origins/network requests. Record actual source/runtime limits and termination behavior. Unit-only sanitizer tests cannot establish browser isolation.

**Failure/rollback:** Reject invalid code/messages; terminate workers; restore previous code/state pair. Prototype state can be discarded only because it is synthetic. No production schema migration.

**Decision gate:** Keep the design only on evidence. If a required primitive/browser fails, stop dependent artifact implementation and record the smallest safe alternative for a contract decision. Do not substitute an unrestricted iframe or `unsafe-eval` to get a green demo.

**Execution record:** Orchestrator/implementer: Codex; branch: `story/e00-s02-artifact-boundary`; base/current-main SHA: `66dc960db9610ff3863b7297eea4195a36586b59`; implementation SHA: `8b0978fca5d6b459a68f67f2e992f3e3c46d9352`; fixed/reviewed SHA: `567dfb8be58952713fafc3a2c09b6cd0565c869a`. Independent adversarial review first requested changes at `8b0978f` for pre-validation activation, forgeable VM bindings/state, same-site local origins, shared relaxed CSP and a browser-start flake. Implementer fixed all findings; re-review verdict: Pass with no findings at `567dfb8`, reproducing typecheck, Vitest 1/1, browser 33/33 and clean diff/status. Runtime proof pins quickjs-emscripten 0.32.0, css-tree 3.2.1, Vite 8.3.0 and Playwright 1.62.0; tested automated engines: Chromium 151.0.7922.34, Firefox 153.0 and WebKit 26.5 on Windows 11 10.0.26200, i5-12450HX, 16 GiB RAM. Playwright 1.63.0/WebKit 26.6 was rejected after reinstall because that build failed host validation for `libxslt.dll`/`libwebp.dll` and exited `0xC0E90002`; 1.62.0/WebKit 26.5 passed, and branded Safari/macOS remains a later deployment qualification rather than a claimed pass. Auth0 was intentionally excluded from the artifact site after checking its separate session layers/custom-domain guidance; tests prove the local `localhost` app cookie/storage sentinel is absent at the `127.0.0.1` renderer. Enforced initial limits: 2 MiB source, 16 MiB QuickJS heap, 512 KiB stack, 1 MiB/message, 100 messages/second, 5-second start/execution ceiling and Stop under 1 second. Candidate `dbbb3eb00f354c32c3cb6aed1bcc754f0f550a3f` was created after `git fetch origin main`; local current main remained `66dc960` (remote `origin/main` remained `ee20bcd`). Candidate commands/results: `npm ci` 0 (53 packages, 0 vulnerabilities), `npm run check` 0, `npm run test:artifact` 0 (33/33 across all three engines), `npm run test:failure` 1 as intended, `git diff --check main..HEAD` 0, clean status. Locally merged by fast-forwarding `main` to merge SHA `dbbb3eb`; post-merge smoke: `npm run check` 0 and Chromium artifact suite 11/11. No production credentials, real financial data, push or remote PR/CI were used. Proof limitations and commands are recorded in `proof/artifact/README.md`; Safari/macOS, deployed registrable domains, production persistence/grants and independent runtime penetration review remain E05/E08 gates, not blockers for this bounded proof.

## E00-S03 — Prove import fidelity with exact fixtures

Status: Done | Epic: E00 | Release: R1 | Dependencies: E00-S01

**Outcome:** The selected CSV/XLSX parsing approach produces a validated canonical proposal with exact values and source provenance, while financial ambiguity stays explicit.

**Contracts:** Architecture data/import contracts §§1–45, money/FX contracts §§535–538 and §540; product ingestion baseline. Record supported encodings, date/decimal conventions and initial workbook limitations.

**Scope:** Minimal bounded parser process, deterministic mapping/validation fixtures, no UI/provider dependency. Synthetic samples cover UTF-8/BOM, quoted/newline CSV fields, locale-separated amounts, debit/credit columns, signed amounts, dates, EUR/JPY/KWD, zero/null distinctions, values above JS safe-integer range, repeated rows, overlapping statements, and formula/external-link workbooks. Never evaluate workbook formulas or fetch links. Decide how cached/formula cells are rejected or surfaced. Document safe failure behavior for unsupported formats.

**Acceptance:**
1. Independently specified expected decimal-string amounts/direction/currencies/dates/source coordinates match exactly; ambiguous amount/currency/date cases cannot silently become canonical money.
2. Reimport creates no extra effects; two genuinely identical transactions in one statement preserve multiplicity; ambiguous overlap is reviewable instead of guessed away. The proof may output match decisions rather than persist them.
3. Corrupt, oversized and expansion-bomb files fail within bounds without compromising the host process. Initial experiment limits: 20 MiB upload, 100 MiB decompressed content, 100,000 rows, 50 columns, 60-second parser deadline, 256 MiB parser process budget. Validate enforcement on the actual runtime/OS or report the unresolved constraint.
4. Produce a fixture manifest with expected results, admitted formats, exclusion reasons and measured runtime/memory. Do not claim all banks or all XLSX workbooks are supported.

**Verification:** Execute golden and hostile fixtures in the isolated parser; assert exact results and bounded rejection. No financial result is checked only against the parser's own recomputation. Test process timeout and recovery of the parent.

**Failure/rollback:** No canonical storage changes in this proof. Report an actionable unsupported/ambiguous result; never partially accept without a specified transaction boundary. Preserve synthetic source only.

**Decision gate:** Record chosen parser/dependencies and enforcement approach. Failed fidelity/security cases block the corresponding accepted input shape until fixed or explicitly excluded in product UX.

**Execution record:** Recovered parked branch `story/e00-s03-import-fidelity` (uncommitted proof tree on base `795bea5`; verified `git status`/diff, no secrets, `.env`/`proof-output/` ignored). Committed parked work as `ccc74e8` ("test: prove import fidelity with exact fixtures", 19 files, +2232/-1). Independent adversarial review: Pass with no blockers at `ccc74e8` (reviewer reproduced typecheck, 23/23 tests, hand-recomputed oracle spot-checks for signed-mixed-currency and debit-credit-de fixtures, 34 edge + 11 hostile/reimport probes, float/network/secret scans; 5 nonblocking suggestions recorded: duplicate-header first-match parser.ts:448-460, column-cap row-end enforcement parser.ts:215-235, multi-sheet ignoredSheets counting path without fixture, coincident-separator plain-Error, per-probe timing strings). Integration candidate `a445f62` (fresh CRLF checkout under core.autocrlf=true) exposed 1/23 failure: raw CRLF kept inside quoted multiline field vs LF oracle. Fix cycle 1 (orchestrator-authored, reviewer-independent): `7dc449b` normalises CRLF to LF inside quoted CSV fields only (RFC 4180 field-data scope; lone CR preserved; amount/date/identity paths untouched) plus a checkout-independent CRLF-vs-LF regression test, README note and manifest status 24/24. Independent re-review: Pass with no new blockers at `7dc449b` (typecheck + 24/24 reproduced, probes confirm no silent money/date change; one nonblocking note deferred: manifest measured.observations prose still says "23/23" while status is pass-24-24 — update on next touch). Rebuilt candidate `aa8b088` after `git fetch origin main` (remote origin/main still `ee20bcd`, stale; local main `795bea5` unchanged): `npm ci` 0 (0 vulnerabilities), `npm run typecheck` 0, `npm test` 0 (1/1), `npm run test:import` 0 (24/24 on CRLF-checkout bytes), `npm run test:failure` nonzero-as-intended (1 deliberate failure), `git diff --check main...HEAD` 0, clean status. Merged FF-only into main as `aa8b088`; post-merge smoke on main: `npm ci` 0 vulns, `npm run check` 0, `npm run test:import` 0 (24/24), `npm run test:failure` nonzero-as-intended, clean status. Runtime pins fflate 0.8.3 (exact, integrity-hashed, zero-dependency); enforced limits: 20 MiB upload, 100 MiB streaming decompressed cap, 100k rows, 50 cols, 200 zip entries, 60 s child-kill deadline, 256 MiB child budget (reduced equivalents documented for timeout/decompressed probes). No remote push/PR (local-only merges, consistent with S01/S02); remote CI still pending E01-S01.

## E00-S04 — Prove durable effects despite worker and queue failure

Status: Done | Epic: E00 | Release: R1 | Dependencies: E00-S01

**Outcome:** One synthetic command is durably accepted and applied once despite retry, process death, stale attempts and complete Redis transport loss.

**Contracts:** Architecture §§175–226, 491–493, 540. Use actual PostgreSQL and Redis/BullMQ with the minimal command/outbox/job/checkpoint/effect shape; do not mock transactional or lease behavior.

**Scope:** A worker increments a synthetic tenant-owned record through an idempotent command, PG outbox, queue relay/reconciler and attempt-generation fence. Kill the worker at each persisted boundary. Only small proof tables/services, no full job orchestration framework.

**Acceptance:**
1. Duplicate delivery and concurrent submissions with the same operation identity create exactly one durable effect; incompatible payload reuse is rejected.
2. Crash before/after dispatch, during execution and after effect commit does not lose accepted work or duplicate the effect on recovery.
3. Flush only the dedicated disposable test Redis, then demonstrate the PG reconciler restores missing work. Never run destructive fault injection against a shared/prod service.
4. A stalled old attempt cannot publish after a new attempt claims the job. Cancel/revoke wins according to the recorded state transition contract and blocks later publication.
5. Starting local proof target: after the deliberately short test lease expires, recovery completes within 30 seconds for 100 commands, with zero missing/duplicate effects. Record lease/heartbeat/reconcile values and environment. This is a test configuration, not the production lease policy.

**Verification:** Runnable real-service integration suite with explicit fault points, exact row assertions and cleanup limited to the test namespace/database. Record commands and service versions; run with a second synthetic tenant to detect unscoped state changes.

**Failure/rollback:** Tests own their synthetic database. Recovery retries a fenced command; never use queue job status as the sole source of truth. Record failure transitions and redacted job/attempt IDs.

**Decision gate:** Carry the proven transaction boundaries into E02-S01/S02. A successful happy-path queue demo alone does not pass.

**Execution record:** Orchestrator/implementer: this session; branch: `story/e00-s04-durable-effects`; base/current-main SHA: `0ec685108410f43c0c9ff652e55d43eb5d98dbb2`; implementation SHA: `ed0775f3187b6821c30808293639703dbe77da65`; fix SHA: `2c9b9bad89ad62b3be0ca2d52f895790219a3303`. Independent adversarial review (separate task contexts): Pass with no blockers at `ed0775f` (reran typecheck, durable 10/10, import 24/24, identity 42/42, plus 8 independent fault/isolation probes P1–P8, all passing), then Pass renewed at `2c9b9ba` after all 7 nonblocking findings were closed (attempt-history preservation on duplicate publish, shared-database guard on DURABLE_PROOF_DB, dedup-framing comment, heartbeat/kill-simulation honesty notes, dead-code removal, IPv6 loopback normalization). Merged with `--no-ff` as `4eefbd802d20625824baa0643cfdb70a510c022e` (merged tree verified identical to reviewed `2c9b9ba`). Post-merge smoke on main: `npm ci` 0 (89 packages, 0 vulnerabilities), `npm run typecheck` 0, `npm test` 0 (1/1), `npm run test:import` 0 (24/24), `npm run test:identity` 0 (42/42), `npm run test:durable` 0 (11/11), `npm run test:failure` nonzero as intended, `git diff --check` 0, clean status. Runtime proof pins bullmq 6.3.6, ioredis 5.11.1, pg 8.23.0, @types/pg 8.23.1 against PostgreSQL 18.6 (disposable `moneo_durable_proof` database, app-role runtime I/O) and Redis 7.0.15 (dedicated logical DB on the local disposable server, loopback-guarded flush); measured on Windows 11, i5-12450HX, 16 GiB RAM, Node v22.23.2 / npm 10.9.8. Acceptance evidence: 20-way concurrent identical submissions + duplicate dispatch apply exactly once with incompatible/foreign reuse rejected; crash before dispatch, after enqueue-before-marking, during execution (300–500 ms test lease, stale generation fenced STALE) and after effect commit all recover with zero loss/duplication; FLUSHDB of the dedicated Redis DB restored 5/5 via the PG reconciler; cancel after claim blocks publication (BLOCKED) while cancel after success preserves history; forged cross-tenant claim/publish denied without disclosure; 100 stalled commands reclaimed and drained in ~190–330 ms (264 ms post-merge) against the 30 s budget with a tenant-B sentinel proving isolation. Proven transaction boundaries (PG outbox + BullMQ transport + attempt-generation fence) carry into E02-S01/S02. Environment notes: local WSL Ubuntu stops after its last client session, so Redis needs a held session during runs (documented in proof/durable/README.md); remote `origin/main` remains `ee20bcd` (stale) and no push was performed, matching prior local-only E00 integrations. No blockers; `.env` remained ignored/untracked and unread into the diff.

## E00-S05 — Qualify identity, deployment identity and development AI

Status: Done | Epic: E00 | Release: R1 | Dependencies: E00-S01

**Outcome:** Record a tested, accessible path for Keycloak sessions, Docker service isolation and OpenRouter development model behavior, with missing prerequisites explicit.

**Contracts:** Architecture identity/security contracts, §130 provider policy and §540; product deployment constraints. Verify current vendor documentation/features/entitlements instead of relying on quoted historical prices or model availability.

**Scope:** Minimal isolated synthetic probes for pinned Keycloak login/logout/session revocation in a disposable Docker network, Docker per-service identity/secret isolation, and free-model tool/structured-output behavior. Use synthetic identities only; do not expose secret values in docs or logs. `start-dev` is admitted only for the bounded proof. Production Keycloak persistence/TLS/backups remain E01/E08 gates.

**Acceptance:**
1. Distinguish app session revocation from provider SSO logout; demonstrate the intended stale-session denial in the probe or retain a blocker for the dependent auth story.
2. Validate non-root/read-only Docker services and per-service secret mounts: the granted service reads its synthetic secret, an ungranted peer cannot, and no long-lived cloud credential is introduced. Documentation alone is not a tested boundary.
3. Execute at most 20 synthetic live requests against an explicitly selected currently available development model, with bounded time/output/retries. Test tool selection, argument schema, malformed-output handling, and an unavailable/rate-limited provider. Deterministic mock cases must cover errors that cannot reliably be triggered live.
4. Record provider/model/version-or-ID, date, free-tier limits, training/retention disclosures and test results. A failing free model may be replaced or used only for development smoke, never silently weaken validation or impersonate production qualification.
5. Define separate development and production config/policy. Production external customer requests require qualified no-training/ZDR routes with no privacy downgrade fallback. No founder/customer real data is necessary for this proof.

**Verification:** Executable synthetic probes plus a short decision/evidence report. Set request timeout to 30 seconds and at most one bounded retry per probe within the 20-request total; expose unavailable status. Do not make provider availability a deterministic CI requirement.

**Failure/rollback:** Remove disposable test sessions/objects as appropriate without deleting shared resources. No production data/migrations. Missing accounts/entitlements are explicit blockers; the orchestrator may continue other independent E00 work.

**Execution record:** Implementer: prior session (commit `f3e0bce`); orchestrator/integrator: this session; branch: `story/e00-s05-identity-provider`; base/current-main SHA at review: `aa8b088`; implementation/reviewed SHA: `f3e0bce` (10 files, +1136/-1: proof/identity REPORT/policy/session-layers/render-oidc/openrouter-probe, test/identity + identity-live, package.json scripts, README, tsconfig include). Independent adversarial review (separate task): Pass with no blockers at `f3e0bce` — reproduced typecheck, 42/42 deterministic, 7/7 live skipped without creds, 24/24 import regression, clean diff/status, zero secret hits, and re-verified all four vendor claims live (Auth0 session layers, Auth0 pricing entitlements gating, Render managed OIDC Pro+ with tea- workspace ID / aud sts.amazonaws.com / one role per service via AWS_ROLE_ARN, OpenRouter ZDR + free-variant limits + error taxonomy). Candidate tree == `f3e0bce` (linear ahead of `aa8b088`; verified after `git fetch origin main`, remote origin/main still `ee20bcd` stale): `npm ci` 0 (55 packages, 0 vulnerabilities), `npm run typecheck` 0, `npm test` 0 (1/1), `npm run test:identity` 0 (42/42), `npm run test:import` 0 (24/24), `npm run probe:identity` 0 (7 skipped — all three live gates Blocked, no creds), `npm run test:failure` 1 as intended, `git diff --check main...HEAD` 0, clean status on Node v22.23.2 / npm 10.9.8. Merged with `--no-ff` as `262d593`; post-merge smoke on main: `npm run check` 0, `test:identity` 0 (42/42), `test:import` 0 (24/24), `probe:identity` 0 (7 skipped), `test:failure` 1 as intended, clean status. Live gates honestly Blocked with precise founder inputs in REPORT.md (Auth0 tenant vars + plan decision; Render Pro workspace ID + IAM provider/role ARN in AWS_ROLE_ARN; dev OPENROUTER_API_KEY; unblocked spend would be <=5 inference + 2 Auth0 reachability within the 20-request cap). No live sessions/objects created so no disposable cleanup; no prod data/migrations; secrets hygiene clean (env names only, key in header at runtime only, synthetic prompts only). Nonblocking reviewer notes carried forward: Render WorkspacePlan exact-matches "pro" (doc says Pro or higher); live retry does not yet honor Retry-After/backoff; 2 catalog GETs sit outside RequestBudget accounting; deterministic test:identity not wired into CI (consistent with test:import, revisit in E01-S01); Auth0 ROPG grant may need confirm/switch at unblock. No remote push/PR (local-only merges, consistent with S01-S03); remote CI still pending E01-S01.

**Correction/closeout record:** Founder decision on 2026-09-17 superseded the blocked Auth0 and Render/AWS path with self-hosted Keycloak and Docker-hosted services for R1; production TLS, persistent PostgreSQL, backup/restore and hosting/network qualification remain E01/E08 gates. Branch `story/e00-s05-live-closeout`, base `081d192eb1e4fdecb8fce36d2ef17d62443fd487`, implementation commits `52b6d50` and `53028fc`, fixed/reviewed SHA `6a4bc4b0ff78be242ff116d53fa7f77a5032ee57`. Independent review first requested five changes, then passed with no findings at `6a4bc4b`: immutable image digests, a unique disposable network, real Compose secret grants, fail-closed verified cleanup, and browser Authorization Code + S256 PKCE using the rotated refresh token after admin revocation. Candidate checks at `6a4bc4b`: typecheck 0, harness 1/1, import 26/26, durable 12/12 (100-command recovery 250 ms), identity 36/36, Docker identity 1/1, live OpenRouter 3/3, artifact browsers 33/33, deliberate failure exit 1 as intended, diff check clean. The Docker proof left no container, network, Compose artifact or temporary credentials. Locally merged with `--no-ff` as `b3e0280acfdd563a9d4211a0344b477dec977656`; post-merge typecheck, import 26/26, durable 12/12 (249 ms), identity 36/36, Docker identity 1/1 and live OpenRouter 3/3 passed. Synthetic inputs only; no secret values were printed or committed; no remote push/PR.

---

## W0 exit audit — 2026-09-17

Independent review of merged `main` at `ad70354b4d8b3e67ec976bef77117d6a319260b6` against the pre-E00 baseline `ee20bcd238acf80b114c1b1601e70e45e8b5e4e0` found the deterministic proof code healthy but initially blocked the W0 exit. All three findings are now closed with approval bound to their corrective SHAs.

- **E00-S03:** add independently expected fee/refund semantics, missing-balance coverage and FX-gap staging/coverage cases required by architecture §540, or obtain and record an authoritative contract narrowing before implementation. Rerun the import suite and affected exact-money checks.
- **E00-S04:** replace call-omission simulations with an actual child worker process killed at the persisted claim, effect/tool-commit, provider-response analogue and publication boundaries; prove recovery/fencing with real PostgreSQL and Redis and no leaked child/connection state.
- **E00-S05:** founder decision superseded Auth0 and Render/AWS with pinned self-hosted Keycloak and Docker-hosted services. Run the revised live Keycloak session-revocation, hardened per-service secret-isolation and OpenRouter probes; production persistence/TLS/backup/hosting remain later gates, not proof substitutions.

E00-S03/S04 correction evidence: implementation `da3967230bc411c4c2c7de04623e7675f16bc597`, fix/reviewed SHA `fe5d836a8dc1d2e6ef210908f503b868ff2016a3`, independent re-review Pass with no blockers. The import suite passed 26/26 with explicit fee/refund direction and incomplete missing-balance/FX coverage. The real PostgreSQL/Redis durable suite passed 12/12, killing disposable worker processes after claim, persisted provider response, idempotent tool-effect commit and fenced publication; one provider checkpoint/effect/counter increment survived recovery, 100 stalled commands recovered in 248 ms, and no child process remained. Latest-main candidate checks at `fe5d836`: typecheck 0, harness 1/1, import 26/26, durable 12/12, identity 42/42, diff check clean. Locally merged as `4111cdd73731b071f731e584686be9846ea4813e`; post-merge typecheck, import 26/26 and durable 12/12 passed (100-command recovery 247 ms).

**W0 exit: Pass** at merged revision `b3e0280acfdd563a9d4211a0344b477dec977656`. The complete latest-main candidate and post-merge smoke evidence are recorded above; E00-S01 through E00-S05 are Done. E01-S01 may now be refined and implemented; E01 remains dependency-ordered.

# Later-wave stories — refine before Ready

The entries below define bounded outcomes, dependencies and minimum acceptance. Before assignment, expand with the template using the actual code, exact commands, fixtures/limits, failure behavior, migration/rollback and review focus. They are not permission to skip inherited safety requirements or invent test evidence.

## E01-S01 — Deploy the smallest application and CI slice

Status: In progress | Release: R1 | Epic: E01
Dependencies: E00-S01, E00-S02, E00-S03, E00-S04, E00-S05 (W0 Pass at `b3e0280acfdd563a9d4211a0344b477dec977656`; HEAD `1b97208` is docs-only, no code revalidation needed)

Outcome: A fresh checkout installs, typechecks, tests, builds and serves a minimal versioned health endpoint; CI runs the same gates plus a synthetic staging deploy/health smoke; a failing required check blocks merge and a rollback to the prior deployment is demonstrated.
Contracts: Architecture R1 deployment/identity override (2026-09-17, §9: self-hosted Keycloak + Docker, no Auth0/Render/AWS), §§348–415 ops/health, §540 gates; product Delivery baseline R1 slice. No Next.js until S06 needs UI — smallest TS HTTP slice on Node built-ins.
Scope: `apps/web/` minimal TS HTTP server (`/healthz`, `/readyz`, `/version`, 404/405 handling, no deps beyond node: built-ins); `Dockerfile.web` (pinned node alpine digest, non-root, read-only capable); `compose.yml` (app + postgres/redis/keycloak pinned digests for synthetic staging only); `.github/workflows/ci.yml` (install, typecheck, deterministic tests, build, staging smoke, secret/diff scan); `.env.example` (names only); `scripts/staging-smoke` (build/run/curl/rollback demo); `test/web-health.test.ts`; README env/commands section.
Out of scope: Next.js/React UI (S06), Keycloak login flow (S02), workspace schema/RLS (S03), commands/money (S04), AI policy (S05), full schema/package tree, production TLS/persistence/backups (E08 gates), paid/cloud provisioning.

Acceptance:
1. Given a fresh checkout, when `npm ci`, `npm run typecheck`, `npm run test:web`, `npm run build:web`, `npm run start:web` run per README, then all succeed and `GET /healthz` returns 200 `{status:"ok", release, gitSha}` with no secret payload.
2. Given a deliberately failing check (e.g. `npm run test:failure`), then the required CI gate exits nonzero and the candidate is not mergeable; evidence shows the red gate.
3. Given a staging deploy of candidate image tag N, when health smoke passes and a prior tag N-1 exists, then rollback to N-1 re-serves `/healthz` 200; build context contains no `.env`/secret files (scan passes, image history shows no secret env).
4. Given the built image, when run as non-root with a read-only filesystem, then `/healthz` still returns 200 and the process does not run as uid 0.

Invariants: No secrets/financial payloads in logs, image layers, CI artifacts or committed files; exact version reporting only. Non-root/read-only service posture from day one.
Failure lifecycle: Unhealthy container fails smoke without replacing the prior deployment; failed smoke leaves prior tag running; no destructive cleanup of shared resources.
UI/accessibility: Not applicable — no browser UI in this slice (reason: S06 owns the shell).
Data changes: None — no migrations, no persistent data; staging uses disposable containers/volumes only.
Observability: `/healthz` (liveness), `/readyz` (readiness incl. build marker), `/version` (release+gitSha, redacted otherwise); CI publishes step exit codes; no payload/secret logging.
Limits: App image build <= 5 min on reference hardware; `/healthz` p95 < 100 ms locally; smoke completes <= 3 min; fixtures: synthetic only.
Verification: `npm ci` 0; `npm run typecheck` 0; `npm run test:web` 0 (new); `npm test` 0 (1/1 regression); `npm run test:failure` nonzero-as-intended; `npm run build:web` 0; `scripts/staging-smoke` 0 incl. rollback demo; `git diff --check` 0; secret scan 0 findings; `docker build` + non-root/read-only probe pass. Deterministic CI tests only; live Keycloak/PG/Redis qualification stays in S02/S03.
Review focus: Secret inclusion in context/image/CI logs; over-broad Dockerfile (unpinned base, root user, writable assumption); CI that cannot actually fail; unreproducible host assumptions; tests that always pass; scope creep toward full Next app or full schema.
Rollout/rollback: Staging-only tags `moneo-web:staging-N`; rollback = re-tag/re-run prior image + health re-check; known limitation: no production TLS/persistent volumes — E08 gates own them.

Execution record:
- Assignee / branch / worktree: Orchestrator/implementer this session / `story/e01-s01-app-ci-slice` (deleted after merge) / main worktree branch
- Base SHA / implementation head SHA: base `1b972081c6c37ac455b20ff047dc698e93423533`; impl `b8af292`; fix `892a3c6`; scan-fix/reviewed `707705b`
- Tests: `npm ci` 0 (0 vulnerabilities); `npm run typecheck` 0; `npm test` 0 (1/1); `npm run test:web` 0 (8/8 new health/version/shape/header/sentinel contract); `npm run test:import` 0 (26/26); `npm run test:identity` 0 (36/36); `npm run test:durable` 0 (12/12 real PG+Redis, 100-command recovery 884 ms; Redis WSL service restarted mid-run, suite fails closed otherwise); `npm run test:failure` exit 1 as intended (red-gate proof); `npm run build:web` 0; `npm run staging:smoke` PASS twice pre-merge (2nd run: prior-tag rollback re-served /healthz, restore re-probed); `git diff --check` 0; tracked-file secret scan 0 findings (GNU sh -e reproduced); no `.env` tracked; zero new dependencies. Env: Windows 11, Node v22.23.2/npm 10.9.8, Docker 29.7.2, node:22-alpine digest `sha256:c610…` (=v22.23.2/alpine 3.24.1), postgres:17-alpine `sha256:18cf…`, redis:7-alpine `sha256:ff02…`, keycloak `sha256:82a7…` (reserved for S02/S03).
- Review: independent reviewer Pass with no blockers at `b8af292` (reproduced typecheck, web 8/8, import 26/26, identity 36/36, hostile probes, non-root/read-only container probe; 5 nonblocking notes). Fix cycle closed 4 (rollback restore+reprobe, JSON exact-prefix env check, `.env*` dockerignore, CI flag parity) at `892a3c6`; re-review found 1 blocker (CI hygiene self-matched `.env.example` + own pattern literal, red gate reproduced under sh -e). Scan-exclusion fix at `707705b`; final re-review Pass at `707705b` (exact step exit 0, positive/negative grep controls verified).
- Integration: `git fetch origin main` — main and origin/main both `1b97208` (unchanged); merge-base == base; candidate == reviewed `707705b`; full candidate gates re-ran green (see Tests). Merged with `--no-ff`.
- Merge SHA / post-merge smoke: `722155f`; post-merge `npm run check` 0, `npm run build:web` 0, `npm run staging:smoke` PASS (candidate→current promote, prior-tag rollback + restore all serve /healthz 200), clean status.
- Remaining blockers or explicitly accepted nonblocking follow-up: none blocking. Accepted: broaden CI secret scan (e.g. gitleaks) as later hardening; `.Config.Env` null-guard one-liner on next smoke-script touch; staging timing limits (build ≤5 min, p95 <100 ms, smoke ≤3 min) not yet measured — first measurement due at W1 exit demo. Remote push/PR not performed (local-only merge, consistent with E00); GitHub branch protection pointing at `ci` unverified — verify when remote write is granted.

Status: Done

## E01-S02 — Authenticate and revoke application sessions

Status: In progress | Release: R1 | Epic: E01
Dependencies: E01-S01 (Done at `722155f`)

Outcome: Two synthetic users complete Keycloak Authorization Code + S256 PKCE sign-in against the app, receive server-checked httpOnly app sessions, and lose API + reconnect access on logout/revocation/expiry; CSRF, open-redirect and token-leak attacks fail closed.
Contracts: Architecture R1 identity override (§9: pinned self-hosted Keycloak, Auth Code + PKCE, server-side sessions, local revocation; `start-dev` proof-only), §§416–489 security, §130 provider policy (dev/prod split — this story adds no AI calls); E00-S05 decision (pinned keycloak digest `sha256:82a7…`, PKCE browser proof, per-service secrets). No Auth0/Render/AWS paths.
Scope: `apps/web/src/auth.ts` (PKCE login/callback/logout, HMAC-signed session cookies, state/nonce, relative-only redirects, Origin/Referer check on logout), `apps/web/src/session-store.ts` (PG-backed `app_sessions`: random 256-bit id, keycloak sub, issued/expires/revoked columns; every API read re-checks DB), `apps/web/migrations/001_sessions.sql` + minimal ordered migrator (no ORM; `pg` promoted to dependencies, same pin), `GET /api/me` server-checked endpoint + reconnect semantics (401 with no token payload), `test/auth.test.ts` deterministic suite against an in-test stub OIDC issuer (synthetic sub/keys, no network), `test/auth-keycloak-live.test.ts` bounded disposable-Keycloak gate (login, refresh-before, admin-logout, refresh-denied, secret isolation reuse from E00 proof; skipped without Docker, never CI-required).
Out of scope: Workspaces/membership/RLS (S03), commands/money (S04), UI shell (S06), production Keycloak persistence/TLS/backups/hosting (E08 gates), WebAuthn enrollment (later slice; password flow in live gate is synthetic-only).

Acceptance:
1. Given a fresh stub-issuer login, when the callback completes with valid state/PKCE, then `/api/me` returns 200 with the synthetic sub and an `HttpOnly; SameSite=Lax; Path=/` session cookie is set (`Secure` on https deployments, plain-http local exempt); the cookie value is a random opaque id (no JWT/sub/token inside).
2. Given a valid session, when logout revokes it (or expiry passes, or admin revocation is simulated at the store), then `/api/me` and a reconnect `GET /api/me` both return 401 JSON with no token/session material; the old cookie cannot be replayed.
3. Given two concurrent sessions for synthetic users A and B, when A logs out, then B's `/api/me` still returns 200 and A's returns 401; sessions never cross.
4. Given forged/missing state, wrong PKCE verifier, cross-tenant issuer (`iss` mismatch), expired stub code, absolute redirect target (`https://evil.invalid` / `//evil`), or cross-origin POST logout without Origin allowlist, then the flow fails closed (4xx, safe landing redirect `/` for GET) and error bodies/headers contain no tokens, codes or secrets.
5. Given the disposable Keycloak container (manual gate), when browser PKCE login → refresh (200) → admin logout → refresh is attempted, then refresh is denied (400/401) exactly as in the E00 proof; app-side revocation (logout/expiry/store revocation) is proven deterministically in `test/auth.test.ts`. Known limitation: Keycloak logout does not propagate to app sessions — app sessions are purely local per the architecture's local-revocation contract, so a user logged out at Keycloak keeps their app session until app logout/expiry; propagation is out of R1 scope unless a later story needs it.

Invariants: Tokens/codes/verifiers never enter logs, error bodies, redirects or committed files; session ids are CSPRNG 256-bit; cookies `HttpOnly; Secure (https only, plain-http local exempt); SameSite=Lax; Path=/`; HMAC key from `SESSION_SECRET` only (fail-closed when missing); issuer identity checked at discovery (exact `iss` match per OIDC Discovery 4.3, same-origin endpoints) plus confidential-client authentication at the token endpoint; user identity comes from the back-channel userinfo endpoint (no local JWT parsing, so no ID-token `aud` claim exists to check — deliberately, to avoid a JWT library).
Failure lifecycle: Failed callback exchanges leave no session row (verified by count); double-logout is idempotent 200/204; expired sessions are lazily purged on read + bounded periodic delete (no unbounded growth); DB-down fails closed 503 with no session oracle (uniform 401/503, no existence signal).
UI/accessibility: Not applicable — no browser UI in this slice (reason: S06 owns the shell; live gate drives Keycloak's own login form via Playwright as in E00).
Data changes: Migration `001_sessions.sql` creates `app_sessions` + `schema_migrations`; rollback `001_sessions.rollback.sql` drops them (sessions are disposable pre-beta; documented data loss = forced re-login). No tenant tables yet.
Observability: Redacted auth events (login_ok, logout_ok, callback_fail with reason code only, session_denied with no sub); `/api/me` 401 body `{error:"unauthorized"}`; no sub/token/cookie values logged.
Limits: Stub-issuer suite <= 60 s; live Keycloak gate <= 5 min, disposable network/containers removed fail-closed; session id 256-bit, PKCE verifier 43–128 chars, state 256-bit, callback replay window single-use (code/verifier consumed on first exchange attempt); pending logins are single-use in-memory with 10-min TTL and 1000-entry cap — single-instance limit (no shared/Redis store until a story scales past one container).
Verification: `npm run test:auth` 0 (new deterministic suite, real PG disposable DB `moneo_e01_test`, fails closed without PG); `npm run test:db` 0 (migrator atomicity incl. failing-file rollback); `npm run test:auth:live` manual bounded Keycloak gate (Docker; skipped without Docker); regression `npm run check`, `test:web`, `test:import`, `test:identity`, `test:durable`; `git diff --check`; tracked-file secret scan. Live gate separate from CI per E00 precedent. CI replay: disposable postgres:17-alpine container + the exact CI role/DB bootstrap SQL, then `test:auth` + `test:db` + `test:durable` against it.
Review focus: Session fixation (login must rotate), cookie flags/scope, HMAC compare timing, PKCE/state single-use + storage, iss/aud checks, open-redirect allowlist, logout CSRF, error oracle (valid vs invalid session indistinguishable), migration rollback safety, scope creep toward workspaces/UI.
Rollout/rollback: App-only; rollback = prior image + `001 rollback.sql` (forces re-login, no tenant data exists yet); known limitation: Keycloak realm config for staging deferred to the story that deploys staging identity (not this slice).

Execution record:
- Assignee / branch / worktree: Orchestrator/implementer this session / `story/e01-s02-auth-revoke`
- Base SHA: `02875995843dc663e950225b83e6dea80e8a449c` (corrected after review: earlier entry recorded a non-resolving truncation)
- Tests: (to be recorded)
- Review: (to be recorded)
- Integration: (to be recorded)
- Merge SHA / post-merge smoke: (to be recorded)
- Remaining blockers or explicitly accepted nonblocking follow-up: (to be recorded)

## E01-S03 — Enforce tenant ownership in the database and API

Status: Draft | Dependencies: E01-S02

Introduce workspace/membership and only needed rows, composite tenant keys/FKs, FORCE RLS and transaction-local context under nonowner roles. Acceptance: two-tenant real-PG tests deny foreign reads/links/writes and reused connections do not retain identity; minimal worker discovery cannot become general bypass access. Migration/rollback and privileged maintenance roles must be explicit.

## E01-S04 — Establish exact command and read contracts

Status: Draft | Dependencies: E01-S03

Implement the first consumed shared command/read function, schema-derived API/client path, decimal-string money/version boundaries, optimistic conflicts and durable command idempotency. Acceptance: same operation retries safely, conflicting versions/payload reuse fail explicitly, >safe-integer values round-trip exactly, and HTTP/domain errors agree. Prove with a small real setting/account operation; do not build a generic command framework.

## E01-S05 — Enforce AI data policy before any provider integration

Status: Draft | Dependencies: E01-S04

Persist account AI exclusions and policy version; introduce the shared authorized data-selection/dispatch gate consumed later by mapping/chat/artifacts. Acceptance: excluded data cannot enter provider payloads even through aggregates or stale work; policy changes invalidate queued work appropriately. Use a recording fake provider now. Define unknown-account upload behavior explicitly before E02-S04 to avoid sending data before account exclusion is known.

## E01-S06 — Add minimal shell, telemetry and safe operational controls

Status: Draft | Dependencies: E01-S04

Build accessible navigation/error/loading shell, redacted request/job correlation and health checks, edge request limits and transactionally enforced operation concurrency where consumed. Acceptance: keyboard navigation and recovery work, cross-tenant identifiers cannot expose data, logs exclude payloads/secrets, and denied work is visible. No staff console or blanket telemetry framework.

## E02-S01 — Persist accepted jobs and outbox dispatch

Status: Draft | Dependencies: E01-S05, E01-S06, E00-S04

Productionize the proven durable acceptance/outbox/BullMQ path for a synthetic import job using tenant-safe rows and operation IDs. Acceptance: commit/dispatch races and duplicate delivery preserve one accepted job/effect; dispatcher failures retry; minimal service roles are enforced. Only one IO worker with needed queue concurrency.

## E02-S02 — Recover, fence and cancel durable jobs

Status: Draft | Dependencies: E02-S01

Implement PG attempt fencing, checkpoints, stalled-job recovery, missing-queue reconciler and cancellation. Acceptance: killed worker, old-attempt completion and full disposable Redis loss cannot lose or double accepted work; cancellation prevents prohibited publication; lease values and user-visible states are documented. Real PG/Redis fault tests required.

## E02-S03 — Upload, quarantine and parse bounded source files

Status: Draft | Dependencies: E02-S02, E00-S03

Implement tenant-scoped upload batches/source objects, file validation/scanning and isolated bounded CSV/XLSX parse from the proof. Acceptance: source rows remain traceable, malicious/unsupported/oversize inputs fail safely, no formula/link executes, object IDs cannot cross tenants and interrupted upload/parser jobs recover. Define lifecycle cleanup with E08 retention in mind.

## E02-S04 — Infer mappings with deterministic acceptance and manual fallback

Status: Draft | Dependencies: E02-S03, E01-S05, E00-S05

Add deterministic profile inference first, bounded OpenRouter assistance where necessary, and optional mapping correction UI. Reuse the qualified transport/config rather than creating a second provider abstraction later. Acceptance: ordinary supported files import without mapping clicks, ambiguous amounts/currency/dates request targeted clarification, excluded/unknown-account data follows the established disclosure policy, and invalid model output cannot write canonical rows. Define a bounded provider reservation here; E04-S01 extends the same ledger rather than replacing it.

## E02-S05 — Commit imports with multiplicity-safe duplicate review

Status: Draft | Dependencies: E02-S04

Persist raw-to-canonical provenance and exact validated transactions atomically at documented batch boundaries; handle file reimports and overlapping statements. Acceptance: identical legitimate rows survive, same-file retry creates no effects, ambiguous overlaps stay staged outside totals, and partial failures expose precise accepted/review/failed counts. Do not deduplicate merely by equal amount/date/description.

## E02-S06 — Complete import and review UX

Status: Draft | Dependencies: E02-S05

Deliver multi-file/account upload, progress/cancel/retry, actionable blocking clarification and nonblocking category review, source/history view and completion events. Acceptance: one blocked file/row does not erase valid work; counts/totals agree; accessible errors link to source; ordinary users never encounter mandatory manual mapping. Completion event is durable and batch-scoped for later initial analysis.

## E02-S07 — Prove the integrated ingestion journey

Status: Draft | Dependencies: E02-S06

Run representative CSV/XLSX batches, second/overlap imports and all recovery boundaries end-to-end; close ingestion defects. Acceptance: independently expected canonical data/provenance and review states match after browser retry, worker death and queue loss. Set supported file matrix and measured resource/latency limits from proof evidence; publish honest unsupported-format UX.

## E03-S01 — Manage accounts, manual transactions and dated balances

Status: Draft | Dependencies: E02-S07

Extend the account records already consumed by import with account list/detail, manual transactions and dated balance entry/correction. Acceptance: currency exponents, signed balances versus transaction direction, missing/zero balance and cutoff behavior match golden fixtures; retries/version conflicts are safe; audit/source indicators distinguish entered versus imported facts. Do not create full asset/debt/investment surfaces.

## E03-S02 — Calculate exact cash and spending semantics

Status: Draft | Dependencies: E03-S01

Implement shared deterministic income/spend/cash calculations with transfers, fees, credit repayments and refunds per architecture §§536–538. Acceptance: transfer principal is not spend, fees are expenses, refund posting-period treatment is consistent, and whole-workspace versus selected-account totals differ only as specified. Cover concurrent correction/recalculation and immutable calculation-version metadata.

## E03-S03 — Add historical fiat valuation with explicit coverage

Status: Draft | Dependencies: E03-S02

Implement architecture §535 historical ECB triangulation and dated audited manual-rate fallback with exact rounding/provenance; confirm current source access/terms. Acceptance: native booked amounts never change, same-date triangulation/maximum prior-rate age apply, unsupported FX yields partial/unavailable coverage rather than zero, and base-currency changes rebuild valuation while preserving old evidence. No cryptocurrency/live trading quotes.

## E03-S04 — Freeze calculation evidence and invalidate derived reads

Status: Draft | Dependencies: E03-S03

Add reproducible immutable calculation inputs/results/revisions, consistent capture and coarse workspace-data revision invalidation for consumed queries. Acceptance: a concurrent correction cannot produce a mixed-version snapshot, historical evidence reproduces its recorded values under current authorization, and revision changes refresh queries without model calls. Do not hold a DB transaction over provider I/O or build a dependency graph.

## E03-S05 — Correct categories/tags and audit reversible changes

Status: Draft | Dependencies: E03-S04

Implement category/tag management and transaction corrections through shared commands, including supported undo and optimistic conflicts. Acceptance: user corrections survive reimport/recalculation, unauthorized/stale/bulk commands cannot bypass validation, and undo references the original audit record without destroying history. Define which destructive/source changes cannot be undone and explain them honestly.

## E03-S06 — Expose the transaction table and source drawer

Status: Draft | Dependencies: E03-S05

Add scoped pagination/filter/sort, selected bulk edits, transaction detail/source/evidence links and exact-money/coverage display. Acceptance: UI totals match query semantics, filters do not bypass account scope, multi-page selection is unambiguous, keyboard interactions work and conflict/error states preserve edits. Add virtualization only if measured volume needs it; no saved-view framework.

## E03-S07 — Confirm basic recurring transactions

Status: Draft | Dependencies: E03-S06

Propose simple recurring candidates from available data and let the user confirm/correct/dismiss their amount/date assumptions. Acceptance: sparse history is labeled, transfers/refunds do not silently become recurring expense, confirmation is audited and idempotent, and future schedule assumptions are distinguishable from booked transactions. No full recurring-calendar product.

## E03-S08 — Verify the financial truth slice

Status: Draft | Dependencies: E03-S07

Run independent cross-currency/cross-account goldens and table/import/correction/undo flows against actual shared queries. Acceptance: JSON boundaries retain exact values including >safe integer, selected-account transfers/fees/refunds/FX/balance cutoff agree with independent expectations, and a second import updates reads without breaking provenance. Record dataset size and query latency targets before execution.

## E04-S01 — Enforce provider policy and atomic usage budgets

Status: Draft | Dependencies: E03-S08, E02-S04

Extend the existing mapping transport/reservation path to shared model calls with explicit development/production routes, bounded output/retries, timeouts and cost reconciliation. Acceptance: simultaneous requests cannot exceed authorized budget/concurrency; unknown usage remains reserved/pending rather than zero; no training/ZDR downgrade fallback for production; revoked policy blocks later dispatch. No generic multi-provider plugin system.

## E04-S02 — Persist chat and its worker-owned model loop

Status: Draft | Dependencies: E04-S01, E02-S02

Implement threads/turns/activity and a durable worker loop from the first model request; web transport subscribes/reconnects. Acceptance: reconnect resumes saved state, worker death/retry does not concatenate independent generations or duplicate tool effects, and separate users cannot read events/turns. Define partial-output display and model retry boundaries explicitly.

## E04-S03 — Expose scoped tools, evidence and dispatch revalidation

Status: Draft | Dependencies: E04-S02, E03-S04

Adapt shared read/domain functions into bounded model tools with current tenant/account/policy context and frozen evidence references. Acceptance: the model has no SQL/database access; prompt injection cannot expand capabilities; excluded data cannot enter aggregates/context or new calls; policy-version changes block stale publication while honestly accounting for already-dispatched work. Test corrupted tool arguments and unsupported questions.

## E04-S04 — Deliver contextual chat, activity and Stop

Status: Draft | Dependencies: E04-S03

Build persistent chat panel, explicit context/coverage, evidence navigation, activity and Stop/retry. Acceptance: user sees what is running, stopping halts future tools/publication within stated bounds, reconnect does not hide completed evidence, and malicious markdown/links/images cannot exfiltrate data. Context from account/transaction/artifact remains permission-checked. No external preview fetching.

## E04-S05 — Confirm financial actions in trusted host UI

Status: Draft | Dependencies: E04-S04

Support one explicitly bounded write action using the shared command path and host-owned confirmation bound to payload, version, expiry and actor. Acceptance: model text/tool arguments cannot assert consent, replay/tampering/conflicts fail safely, and retry commits at most once with audit/undo where supported. Extend to additional R1 actions only as required; no external money movement.

## E04-S06 — Show included-AI settings and usage

Status: Draft | Dependencies: E04-S05

Expose account AI exclusions, read-only active prompt/version, model/usage/cost and limits/errors in settings. Acceptance: changes affect queued/new work through existing policy gates, unknown cost is visibly pending, provider errors are actionable, and displayed prompts exclude secrets. No custom keys/models/editable prompts in R1.

## E04-S07 — Qualify grounded AI behavior

Status: Draft | Dependencies: E04-S06

Create versioned synthetic evaluations for mapping, numerical grounding, evidence completeness, abstention, tools, exclusions and hostile input. Acceptance: independently expected factual/numeric claims and unauthorized-action tests pass the predeclared rubric; live candidate model/route scores are recorded separately from deterministic CI. Set minimum sample/thresholds before running; a free model that fails is not automatically production-qualified.

## E05-S01 — Productionize isolated build and artifact versions

Status: Draft | Dependencies: E03-S08, E00-S02

Persist tenant-owned artifact source/immutable versions and isolated validation/build jobs using the proven sandbox design. Acceptance: builders have no customer finance credentials, code/source/resource bounds apply, invalid build never replaces the active version, and foreign version IDs cannot be read/activated. Use synthetic build previews and the actual bounded compiler path; no arbitrary package installs.

## E05-S02 — Run the trusted renderer and terminable VM

Status: Draft | Dependencies: E05-S01

Integrate separate-site runtime, exact CSP/worker assets, sanitized render protocol, execution/message/memory bounds and clear termination errors. Acceptance: hostile E00 cases continue to pass against deployed configuration in supported browsers; generated content cannot acquire host DOM/network/navigation credentials. Enforce resource limits across multiple open artifacts, not only one isolated demo.

## E05-S03 — Supply a scoped live Finance SDK

Status: Draft | Dependencies: E05-S02, E03-S04

Issue server-authorized runtime grants for a small read-only SDK backed by shared queries/evidence and data revisions. Acceptance: live refresh on second import requires no model call, token/account/policy revocation stops reads/publication, forged cross-tenant/query capabilities fail, and private values never enter build logs. Document the supported API/subset, query bounds and coverage semantics.

## E05-S04 — Persist local state with atomic version activation and revert

Status: Draft | Dependencies: E05-S03

Implement bounded artifact-local state, version compatibility/migrations and atomic active code/state transitions. Acceptance: reload restores state, two tabs cannot silently overwrite newer versions, failed migration retains prior working code/state, and revert selects a compatible pair rather than pairing old code with arbitrary new state. Tenant/policy checks apply to all state endpoints.

## E05-S05 — Add the manual editor and compact/full artifact views

Status: Draft | Dependencies: E05-S04

Deliver editable HTML/CSS/JS, validate/preview/publish errors, version history/revert and compact/full render modes with keyboard support. Acceptance: editing a chart/control works with explicit supported-API guidance; invalid changes preserve the active artifact; view-only users cannot mutate; expensive loops remain stoppable. No IDE, browser compatibility layer or arbitrary npm support.

## E05-S06 — Generate and edit artifacts through contextual AI

Status: Draft | Dependencies: E05-S05, E04-S07

Use the existing chat/tool loop to create/propose bounded artifact changes against an explicit version; validation/build/publish goes through the same path as manual edits. Acceptance: stale edits surface conflicts, unsupported code fails safely, prompt injection cannot elevate grants, and financial write controls use E04's trusted confirmation if offered. AI cannot fabricate consent; state/version rollback remains intact.

## E05-S07 — Verify hostile and live artifact journeys

Status: Draft | Dependencies: E05-S06

Run chart/scenario creation, manual and AI edits, reopen/revert, second-import refresh, failed migration and multi-artifact resource attacks. Acceptance: supported-browser deployed tests preserve host responsiveness, no forbidden network/DOM access occurs, exclusion/revocation affects open views, and failed versions retain the working one. Record measured caps and unresolved launch blockers for E08 independent review.

## E06-S01 — Model explicit daily projection inputs

Status: Draft | Dependencies: E05-S07, E03-S07

Persist/validate the minimal dated balances, horizon, expected income/recurring assumptions and three named case inputs needed by daily cash projection. Acceptance: default eight-complete-week baseline follows the product contract, missing history demands explicit assumptions rather than zero, and month-end/leap-year/exact remainder schedules are deterministic. No probabilistic model registry.

## E06-S02 — Manage basic goals and virtual allocations

Status: Draft | Dependencies: E06-S01

Implement simple savings goals and virtual allocations with parent-row/concurrency protection. Acceptance: simultaneous commands cannot overallocate, virtual earmarks create no new cash, edits/undo are versioned/audited, and reservations remain attributable to accounts/goals. No spending plans, branch trees or conflict engine.

## E06-S03 — Compute case projections and Available to Spend

Status: Draft | Dependencies: E06-S02

Implement architecture §258 and daily Expected/Conservative/Optimistic outputs through shared exact queries. Acceptance: account liquidity/transfer timing/floors/reserves constrain spend, holds are not double-counted, negative headroom shows zero plus shortfall/date, and missing required coverage returns unavailable. Evidence captures assumptions/FX/calculation version; no probability or safety guarantee wording.

## E06-S04 — Compare flat what-if scenarios

Status: Draft | Dependencies: E06-S03

Add basic goal/projection UI and saved flat scenarios with explicit hypothetical inputs and comparable output horizons. Acceptance: scenario edits never mutate actual transactions, cases and coverage are clear, conflicts/errors preserve input, and AI/artifact adapters reuse the same calculations. No scenario branching or scheduled recomputation by AI.

## E06-S05 — Verify planning invariants across UI, AI and artifacts

Status: Draft | Dependencies: E06-S04

Run independent daily financial fixtures, concurrent allocation tests and shared-output integration checks. Acceptance: UI, chat and artifact receive identical authoritative results under the same inputs; exclusions and missing balances cannot become false certainty; saved scenarios reopen/recalculate on data changes with clear assumptions. Record forecast horizon and performance limits before measurement.

## E07-S01 — Trigger one bounded initial Deep Analysis

Status: Draft | Dependencies: E06-S05, E02-S06, E04-S07

Consume durable accepted-batch completion, coalesce nearby imports and run a checkpointed bounded investigation of available core data. Acceptance: duplicate events do not launch duplicate expensive runs, accepted partial data carries warnings, minor corrections/second imports refresh ordinary reads without mandatory new AI, Stop/retry/revocation work, and missing coverage limits claims. Define coalescing window/tool/cost/time caps before Ready; no scheduled specialists.

## E07-S02 — Render trusted Home before AI completes

Status: Draft | Dependencies: E07-S01

Build one dashboard with deterministic metrics/coverage and a few evidence-backed initial findings as analysis progresses/completes. Acceptance: Home remains useful while AI is slow/unavailable, unsupported findings are withheld, and initial personalization does not overwrite later user edits. Metrics use shared queries, not generated arithmetic.

## E07-S03 — Pin and arrange persistent artifacts

Status: Draft | Dependencies: E07-S02, E05-S07

Add pin/unpin/reorder and limited tile sizes with compact/full opening. Acceptance: layout persists across reload/tabs with explicit conflicts, keyboard actions work, revisions refresh live data, and deleting/revoking artifacts cleans or invalidates pins safely. No multiple-dashboard abstraction.

## E07-S04 — Complete navigation and job feedback

Status: Draft | Dependencies: E07-S03

Add basic navigation palette, in-app completion/error notices and links to jobs/evidence with consistent empty/loading/error states. Acceptance: notices cannot cross tenants or revive deleted data, failed jobs provide an authorized recovery path, and keyboard/focus behavior is coherent across Home/chat/import/artifacts. No natural-language cross-object search engine.

## E07-S05 — Demonstrate the complete core loop

Status: Draft | Dependencies: E07-S04

Browser/system-test upload → targeted clarification/correction → grounded answer → artifact generation → manual edit → pin → reopen → second import → automatic live refresh, including Stop and failed-edit retention. Acceptance: fixtures reconcile with independent totals and evidence, no routine mapping is mandatory, Home is available before AI completion, and the journey is accessible. Record first-use time/cost and failure points; synthetic demo is not demand validation.

## E08-S01 — Complete export, deletion and retention lifecycle

Status: Draft | Dependencies: E07-S05

Implement complete authorized export and deletion across canonical/raw data, objects, conversations/evidence, artifacts/state, jobs and caches with audited tombstones and bounded retention. Acceptance: cross-tenant requests fail; deletion is resumable/idempotent, revokes access/queued work immediately as specified, and backup/provider retention limitations are explicit. Public privacy text must match actual lifecycle behavior.

## E08-S02 — Restore safely and prove operational recovery

Status: Draft | Dependencies: E08-S01

Configure/test backups and restore in an isolated restricted recovery environment, reapply deletion tombstones and revalidate queue reconciliation/migrations/deploy recovery. Acceptance: previously deleted data does not reappear to users, exact financial evidence survives, and measured recovery time/data-loss window meet predeclared beta requirements. Document incident/restore/rollback commands, owners and redacted alerts. No raw production copies in ordinary staging.

## E08-S03 — Qualify production AI and customer-data disclosure

Status: Draft | Dependencies: E08-S01, E04-S07

Choose available production model/routes that pass the evaluation rubric and enforce no-training/ZDR policy, budgets and explicit international processing disclosures. Acceptance: misconfigured/unavailable compliant routes fail closed, no silent free/training fallback, retention/processor configuration matches documents, and production credentials are separated. Resolve required processor/privacy arrangements before external financial data; a development free-model smoke is insufficient.

## E08-S04 — Independently review tenant, finance and artifact boundaries

Status: Draft | Dependencies: E08-S02, E08-S03

Commission independent review of the actual deployed runtime and application boundaries, including hostile artifact/browser tests, tenant swaps, prompt injection, ingestion limits, RLS roles and financial failure cases. Acceptance: every release blocker is fixed and independently rechecked against the final candidate, with remaining nonblocking issues and rationale recorded. This is review of implemented controls, not their first introduction; no automatic pass from an agent checklist.

## E08-S05 — Establish load, failure and cost release gates

Status: Draft | Dependencies: E08-S04

Measure representative import/query/projection/multi-artifact/AI concurrency, cancellation and recovery against predeclared dataset sizes and numerical budgets. Acceptance: limits enforce safe rejection/backpressure, cost reservations bound concurrent spend, observability alerts expose failures without private payloads, and the complete release journey survives agreed failure drills. Record supported scale honestly; do not invent a traffic/SLA promise. Gate controlled beta on all E08-S01–S05 evidence and privacy readiness.

## E08-S06 — Validate a controlled cohort and decide the next release

Status: Draft | Dependencies: E08-S05

Founder defines an invited consenting cohort and predeclares sample/window/decision rubric before observing results. Measure import repair, incorrect claims, artifact edit/repair effort, time to useful output, cost and repeat use/reopened tools. Acceptance: completed observation with anonymized aggregate findings and an explicit go/iterate/no-go decision, not a guaranteed positive demand result. Final R1 review accounts for every baseline capability; public launch requires the applicable privacy/legal/operational review and founder release decision. Write R2 stories only from these findings.
