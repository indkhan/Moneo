# Category competitor research

- Requested: research how Finanzguru, Copilot Money, and comparable finance apps categorize transactions before finalizing Moneo's plan.
- Done: inspected Moneo's current transaction/import model and compared official documentation from Finanzguru, Copilot Money, Monarch Money, YNAB, Plaid, and Actual Budget. No application code was changed.
- Approach: focused on automatic assignment, transaction types, merchant normalization, user corrections, reusable rules, confidence/review behavior, transfers, and category customization. Local-first Actual Budget is the closest architectural reference; cloud ML products are useful UX references but do not fit Moneo's privacy constraint.
- Validation: documentation-only research; no code validation run.
- Follow-up: complete product decisions for taxonomy, correction learning, initial built-in rules, and the import-quality gate before implementation.
