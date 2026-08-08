# CSV import hardening

- Requested: implement the agreed CSV-import P1 and P3 fixes in small commits with rigorous tests.
- Done: removed unused chart/navigation code; made Commerzbank detection require the full shape; validated corrected ISO dates and three-letter currencies; versioned mapping signatures to include configuration while retaining legacy lookup; added cautious generic column prefilling; updated `application.md`.
- Approach: pure-helper regressions were written and observed failing before each behaviour change. Generic detection is deliberately limited to unique common date/title/amount/currency columns with unambiguous date and number formats; account labels still require user input.
- Validation: `npm test`, `npx tsc --noEmit`, and `npx expo export --platform web` passed.
- Remaining risks: generic mapping is conservative and does not infer bank or account identity. Existing mappings remain readable through the legacy signature path.
