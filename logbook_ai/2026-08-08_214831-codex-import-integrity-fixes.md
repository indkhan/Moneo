# Import integrity fixes

- Requested: implement the problems found in the adversarial review.
- Done: duplicate rows within a single CSV are skipped; Commerzbank and mapped status corrections now work; malformed CSV-shape errors no longer offer an unusable correction input; category edits default to one transaction. Updated `application.md`.
- Why: small local changes preserve source data and require an explicit choice before applying a counterparty rule broadly.
- Validation: added red-green regression tests; `npm test` passed (67 tests), `npx tsc --noEmit` passed, and `npx expo export --platform web` passed.
- Follow-up: the generated `.moneo-web-verification/` directory remains because this environment blocked its recursive deletion.
