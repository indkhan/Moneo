-- Dispatcher claims survive process crashes: a lease eventually returns an
-- unpublished event to the pending pool for at-least-once delivery.
ALTER TABLE outbox_events ADD COLUMN claimed_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE outbox_events ADD COLUMN last_error text;
--> statement-breakpoint
CREATE INDEX outbox_events_claim_lease_idx ON outbox_events (status, claimed_at);
