# Browser acceptance

Use `npm run test:e2e -- --workers=1 --output=.qa/final-e2e-results` with the configured local app and applied migrations. The config reads `.env`; it reuses a running port3000 server. Stop that server before building so build/dev do not write the same `.next` directory.

Authenticated specs require `E2E_STORAGE_STATE` pointing at an ignored Playwright storage state, or `e2e/.auth.json`. Other gated specs create their own disposable users and require `SUPABASE_DB_URL`, the public Supabase variables and `SUPABASE_SERVICE_ROLE_KEY`. No production authentication bypass is used and no test emails are sent. Never commit credentials, auth state, private statements or detailed private evidence. A skipped required authenticated spec is not a pass.

Use an empty disposable workspace for the full suite: the core journey independently expects its initial two ledger entries. Run with one worker because several authenticated specs mutate the same supplied workspace/preferences. Specs that create users remove their exact fixtures in `finally`; ignored `.qa` recovery journals retain IDs if interrupted. Remove only those recorded QA records and storage objects after acceptance.

## Coverage and limits

- Anonymous smoke and mocked import journeys verify health, login, empty/error states and deterministic UI contracts.
- `core-journey.gated.spec.ts` uses real auth, confirmation/import workflow, ledger, chat, goals and pinning; file interpretation/tool proposals/manual analysis start are explicitly mocked. It proves overlapping rows are held for review. Separate private-file and free-provider acceptance supplies the actual parsing/model evidence; mocks are not provider verification.
- Money, verified-link, goal/reservation, wealth, budget-rollover and scenario specs exercise actual persisted actions, exact totals, history/undo, source preservation and unchanged canonical data for hypothetical scenarios.
- `recurring-source.gated.spec.ts` independently asserts EUR990→1000→990 forecast when a confirmed source becomes a transfer then is undone.
- `review-freshness.gated.spec.ts` asserts current→stale→unknown evidence, retained full saved review and live exact tool balances updating100000→90000 after a dated correction; denied scopes supply no balance data.
- Artifact specs exercise actual compiled QuickJS workers, host/network denial, limits/recovery, native Stop, live output validation, real SDK permission revocation, direct edits/invalid revisions/restore and PNG/PDF exports. AI generation/edit and provider cancellation have separate actual acceptance evidence; deterministic fixtures do not claim model quality.
- `two-user-isolation.gated.spec.ts` exercises owned and foreign pages/APIs/files/RPCs/workflows, account/view histories and deterministic insight dismissal/restore/muting/exact relevance settings. SQL fixtures cover every current table and service boundary.
- `auth-refresh.gated.spec.ts` verifies persistent authenticated cookies; when supplied an actually expired session it also asserts rotation. Fresh-session acceptance alone does not prove rotation.
- `accessibility.gated.spec.ts` checks eight routes at360px, persisted dark appearance, native modal keyboard/background focus blocking/Escape/focus return. Scenario acceptance adds skip-link/de-DE/invalid horizon checks. These targeted checks are not a blanket WCAG certification.
- `import-control.gated.spec.ts` requires051 and exercises real partial Stop/Resume, worker fencing, exact progress/idempotency/source retention and full undo. Separate SQL/three-connection checks cover races; missing required migration fails explicitly.

Final acceptance also requires unit tests (enable live DB resolver parity), lint/build, fresh/upgraded schema checks and deployed revision/health/auth/journey checks. Production Vercel administration/cron/logs require actual project access; local success does not establish deployment success.
