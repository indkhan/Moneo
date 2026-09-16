# E00-S03 import-fidelity proof

Feasibility proof, not production ingestion. It shows a minimal bounded
parser turning synthetic CSV/XLSX bytes into a validated canonical proposal
with exact decimal-string money and source provenance, while every ambiguity
stays explicit instead of silently becoming money.

## Run

```powershell
npm ci
npm run typecheck
npm run test:import
```

`proof-output/` stays empty for this proof: every assertion runs in-process
or in a disposable child whose outputs are ephemeral temp files. Committed
synthetic sources live in `fixtures/`; hand-specified expectations live in
`fixtures/manifest.json`, which is the independent oracle the tests assert
against (never the parser's own recomputation).

## Chosen parser and dependencies

- CSV is parsed by a hand-rolled strict RFC 4180 reader
  (`proof/import/parser.ts`): no CSV dependency, so delimiter, quoting and
  newline behaviour are fully audited. Only UTF-8 (with/without BOM) is
  admitted; anything else fails as `unsupported-encoding`. CRLF inside quoted
  fields is normalised to LF so Windows exports and CRLF checkouts parse
  identically to LF bytes.
- XLSX is read with `fflate@0.8.3` (tiny, no dependencies) in streaming
  `Unzip` mode with a running decompressed-size cap, plus a targeted
  SpreadsheetML subset reader (shared strings, inline strings, plain/numeric
  cells of the first worksheet). Chosen because it never evaluates formulas,
  never resolves external targets, and lets the proof abort an expansion
  bomb before materialising it. Rejected alternative: a full spreadsheet
  library (larger, formula-aware surface the proof must not depend on).
- Money is derived from raw decimal text with `BigInt` only; JavaScript
  numbers never carry authoritative amounts, including values above the safe
  integer range. Currency exponents are proof-scoped to EUR (2), JPY (0) and
  KWD (3); anything else is `unsupported-currency`, never converted by guess.

## Admitted shapes and explicit exclusions

Admitted: comma/semicolon-delimited CSV with a declared mapping, signed or
debit/credit amounts under a declared decimal/thousands convention, ISO /
`DD.MM.YYYY` / `MM/DD/YYYY` / Excel-serial dates under a declared format,
single-first-sheet workbooks at `xl/worksheets/sheet1.xml`.

Excluded with reasons (see `fixtures/manifest.json`): non-UTF-8 bytes,
undeclared delimiters, spaced/symbol/parenthesised amounts, sub-minor
precision (never rounded silently), unrecognised or impossible dates (century
and field order never guessed), formula cells in consumed columns (cached
values discarded, row stays reviewable), workbooks with external links
(whole file rejected, links never fetched), sheets beyond the first
(consumed sheet reported, remainder counted as `ignoredSheets`).

Zero-value rows remain observations with a `rejected` (`zero-amount`)
disposition per architecture section 2.5; they never become canonical money.

## Resource envelope (initial experiment limits, not production promises)

- upload: 20 MiB pre-check (parent and child)
- decompressed XLSX content: 100 MiB streaming cap
- rows: 100,000, columns: 50, zip entries: 200 (fail fast while parsing)
- parser deadline: 60 seconds, enforced by killing the child
- parser process budget: 256 MiB via `--max-old-space-size`

The child exits 0 with a structured body for every bounded rejection;
nonzero exits (2/3) and null bodies are reserved for unexpected child
failure, and a kill surfaces as `timedOut` with a null body. Tests use
shorter timeouts and smaller caps to prove the same enforcement mechanism
without waiting out production values. The `hangMs` job field exists only
for that timeout probe and is never used outside tests.

## Reimport semantics (architecture 537)

Within one file, `(file, rowNumber)` identifies an observation, so two
genuinely identical rows keep multiplicity (both accepted, distinct
observations). Across imports, an identical observation hash is
`matched_existing` (no new effect); an identical economic shape under a new
hash is an `overlap_candidate` surfaced as `needs_review`
(`possible-overlap`) — never auto-linked. The proof outputs decisions; it
writes no canonical storage.
