# Transaction categorization competitor research

- Requested: research how competing personal-finance apps categorize transactions and identify the current best simple approach for Moneo.
- Done: inspected Moneo's classifier, persistence, correction UI, CSV evidence, product docs, and prior category decisions; compared official documentation for Copilot, Monarch, YNAB, Rocket Money, Simplifi, Lunch Money, Commerzbank, Plaid, Tink, and Salt Edge. No product code was changed.
- Approach: recommend a measured local hybrid first: stable merchant normalization, verified Commerzbank category mapping, deterministic personal correction memory, ambiguity-aware abstention, and a review queue. External enrichment is a later consent/backend decision and must win a German-data bake-off.
- Validation: no tests run because this was research only; repository status and relevant implementation paths were inspected.
- Follow-up: obtain a privacy-safe labelled sample of representative transactions and agree precision/coverage targets before designing category v2.
