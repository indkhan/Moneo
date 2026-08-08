# Add AI logbook policy

- Requested: Preserve what each AI run did and why so later runs can review its history.
- Done: Added an append-only, one-file-per-task logbook convention to `AGENTS.md` and noted it in `application.md`.
- Why: Separate timestamped files retain both old and new decisions without merge-prone shared-file edits. Entries are concise to limit stale context and repository noise.
- Validation: Reviewed the resulting documentation and repository diff; no application tests were needed for a documentation-only change.
- Follow-up: Future agents should create a new `logbook_ai/` entry at the end of every repository task and must not modify earlier entries.
