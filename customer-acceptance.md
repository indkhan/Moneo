# Customer acceptance — 2 October 2026

Private statement inputs were used for local acceptance. Identifying input details are retained only in ignored local evidence.

## Verified customer journey

- Private statement imports were exercised with source retention and review semantics preserved.
- A live deep review completed and retained its full narrative and dated evidence after the output-budget fix.
- AI calculator generation, saving, runtime execution and month changes were exercised. A generated comparison chart ran on exact host-built account totals; switching months loaded matching dated evidence. Results now render as readable tables with exact currency amounts.
- Charts were inspected in the collaborative browser. A stale browser tab after restarting the development server required opening a fresh tab; the fresh tab rendered the chart and editor correctly.

## Fixes committed individually

| Problem reproduced | Resulting behavior |
| --- | --- |
| Invalid cashflow output passed smoke validation | Validation now exercises the declared cashflow branch before activating a version |
| Deep review returned empty output | Minimal reasoning and a larger narrative budget; live review subsequently completed |
| Statement interpretation stayed busy without cancellation | Bounded provider/client requests, cancellation and protection against late results |
| Generator omitted renderer field types | Explicit output contract for summaries, rows, numbers and charts |
| Chat could not create requested artifacts | Explicit requests can create existing trusted templates and return clickable links |
| Parallel tool calls could create duplicate artifacts | One shared creation promise per chat request |
| A selected month relabeled another month's evidence | Host-side month selection; unsaved month changes suppress financial output until refreshed |
| Chat confused total rows with included rows and inferred unsupported bounds | Included-row counts and explicit limitations in financial evidence and prompts |
| Chat guessed import completion from stale balances | Scoped import workflow status tool with separate classification limitations |
| Generated tools lacked account comparisons | Exact per-account totals from the existing permitted financial operation |
| Chart displayed minor units | Currency-unit coordinates and exact monetary tooltips |
| Generated rows displayed raw JSON | Escaped semantic tables and exact currency formatting |
| Goal creation retained the old Plan page | Revalidate financial pages before redirecting |
| Long descriptions split amounts across lines | Preserve amount width while descriptions wrap |
| A stalled history refresh left import controls busy | Ten-second history timeout, clear retry error, restored controls; browser regression covers it |

## Remaining problems and limits

- The configured free model still made unsupported statements in some live responses despite precise tool data and instructions. Examples included treating excluded rows as necessarily understated spending and confusing unresolved financial kind with a missing category. Stronger evidence and prompts improve responses but do not establish reliable financial prose. Deterministic totals remain the authority.
- Imported account names are filename-heavy, and a Savings product currently receives the default checking type. Audited account rename/type editing works; import metadata proposals need improvement.
- Custom comparisons can show account IDs when the artifact does not declare permission to read account names. Category breakdowns are not yet supplied to custom snapshots. Chat creation currently uses existing trusted templates; custom generation and activation remain a separate reviewed UI flow.
- Saved AI reviews and older chats still expose Markdown punctuation. The artifact page also exposes code and manifest controls prominently. These need a separate presentation pass.
- One source required 229 classification reviews. Those ambiguities were preserved, not automatically guessed. Stale/missing current balances correctly leave affordability and net worth unavailable; completed imports do not establish complete financial coverage.
- Browser coverage includes real persistence, permissions, undo, source retention, sandbox denial, cancellation and exports. Some provider boundaries in deterministic E2E are mocked; actual private-file/provider runs above supply separate live evidence. Local checks do not establish deployment acceptance.

## Final verification

- `RUN_RESERVATION_DB_TESTS=1 npm test`: 69 files, 258 tests passed, no skips.
- `npm run lint`: passed.
- `npm run build`: passed after the final application changes.
- All 38 distinct browser cases passed across full-suite runs and targeted rechecks. This was not one uninterrupted green full-suite run: the first run found the goal cache bug and an account-edit timeout; the goal was fixed, and both cases passed on recheck. A fresh full run passed 35 of 37 cases but encountered a service delay during core import/history and anonymous Home. A clean-workspace core/smoke recheck passed all five cases. The added stalled-history regression passed after the recovery fix. Logs retain these failures as well as the successful rechecks.
- All four recorded disposable QA users/workspaces and their seven uploaded storage objects were removed after ownership checks. Local authentication-state files were removed. The original supplied CSVs and pre-existing user edits were left intact.
- Changes were committed in separate chunks. No deployment or push was performed.

Ignored `.qa` logs retain local execution evidence: `final-unit.log`, `final-lint.log`, `final-build.log`, `final-e2e.log`, `fix-e2e.log`, `acceptance-e2e.log`, `core-recheck.log`, and `history-timeout-green.log`.
