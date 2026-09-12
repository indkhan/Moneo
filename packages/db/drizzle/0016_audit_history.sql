-- Epoch 5, Issue 5.6 — presentation fields for immutable finance history.
ALTER TABLE audit_events ADD COLUMN reason text;
--> statement-breakpoint
ALTER TABLE audit_events ADD COLUMN related_ai_run_id text;
