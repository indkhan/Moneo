# Custom transaction category discussion

- Requested: discuss and plan the simplest flow for creating a category from a transaction, warning about existing similar categories, and applying it to matching transactions.
- Done: inspected the current transaction UI, fixed taxonomy, counterparty matching, reusable category rules, persistence, `application.md`, and backlog. No product code was changed.
- Approach: reuse the existing normalized counterparty rule and `categoryRules` persistence instead of introducing a new matching engine; identified category-name persistence and the exact meaning of "similar" as the remaining product decisions.
- Validation: Not run because this was an inspection and planning task with no implementation changes.
- Follow-up: agree on matching scope and duplicate-name behavior before implementation.
