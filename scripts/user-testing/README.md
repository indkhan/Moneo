# Persona walkthrough plan

Generate from the repository root with `node scripts/user-testing/build-plan.mjs` and `node scripts/user-testing/build-fixtures.mjs`. Requires the Codex artifact-tool runtime; set `ARTIFACT_TOOL_PATH` to its `dist/artifact_tool.mjs` when installed elsewhere. No application dependencies are added.

The plan has 299 individual cases across 18 walkthroughs for 11 personas. Each case includes prerequisites, viewport, action, expected behavior, separate usability judgment, priority, execution status, evidence and finding links. Fixtures are synthetic examples, including malformed and oversized files. Their fixed dates are for parsing tests; adjust dates explicitly before current-month finance assertions.

Outputs live under ignored `.qa/user-testing/`: `test-plan.csv`, `cases.json` and `fixtures/`. Keep all execution results, screenshots, authentication state and findings with identifying evidence there. The privacy gate intentionally forbids tracked CSVs and `.qa` evidence. Plan source contains no credentials or private statement data.

Execute the sequential walkthroughs with the persistent QA user only. Never reset a real workspace. The existing QA-auth reset command verifies its user marker, but do not reset a populated QA workspace when preserving prior evidence. Record unmet prerequisites as blocked rather than interpreting them as product failures. Use `PASS` only for the entire row's actual assertions; route loading and related mocked tests alone establish only partial coverage. Never submit real bank consent, send auth emails or perform account deletion merely to test a button.

Browser automation can verify deterministic interactions and layout. A screenshot or semantic check does not establish assistive-technology compatibility, provider quality, deployed scheduling or real banking behavior. Preserve those limitations in the execution report.

After collecting the 27 independent page reports in `.qa/user-testing/page-audits/`, run `node scripts/user-testing/build-page-audit.mjs` to generate `page-ui-ux-changes.csv` and `PAGE-AUDIT-INDEX.md`. The exporter verifies every page has findings. The CSV retains complete evidence, proposed changes and acceptance criteria; source-supported recommendations must not be represented as reproduced defects. Page recommendations may overlap and should be consolidated before implementation.

Follow-up reviews add their results beside the originals under ignored `.qa/user-testing/` and mark duplicates or corrections of earlier findings. When crawling the app, do not follow links with a `start` query: `/ai/artifacts/[id]?start=` sends its prompt to the model on page load.
