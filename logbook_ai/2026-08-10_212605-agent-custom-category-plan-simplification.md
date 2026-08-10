# Custom category plan simplification

- Requested: challenge whether the proposed custom-category implementation was truly the simplest extension of existing behavior.
- Done: re-evaluated the plan against the current inline category picker, normalized counterparty matcher, atomic rule application, and future-import classification. No product code was changed.
- Approach: recommend extending the existing editor and rule record rather than creating a separate modal workflow or new persistence concept; reduce the likely implementation to two commits.
- Validation: Not run because this was a planning refinement with no implementation changes.
- Follow-up: confirm whether a literal modal is required or whether opening the existing inline editor directly from the `Needs category` badge satisfies the desired interaction.
