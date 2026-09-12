-- Epoch 4, Issue 4.10 — persist the command input hash.
--
-- The Issue 2.2 executor rejects "same idempotency key, different input"
-- loudly (IDEMPOTENCY_KEY_REUSED) instead of replaying the wrong result.
-- That check needs the original input hash beside the stored result, so the
-- Drizzle command store (Issue 4.10) persists it at claim time. No backfill:
-- pre-4.10 rows predate any command traffic and read back as ''.
ALTER TABLE command_operations ADD COLUMN input_hash text NOT NULL DEFAULT '';
