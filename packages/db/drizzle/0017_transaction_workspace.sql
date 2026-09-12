-- Epoch 5, Issue 5.7 — durable views and frozen large-action targets.
CREATE TABLE saved_transaction_views (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT saved_transaction_views_workspace_name_uniq UNIQUE (workspace_id, name)
);
--> statement-breakpoint
CREATE TABLE frozen_transaction_selections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  query_definition jsonb NOT NULL,
  transaction_ids jsonb NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX frozen_transaction_selections_workspace_expires_idx ON frozen_transaction_selections (workspace_id, expires_at);
--> statement-breakpoint
ALTER TABLE saved_transaction_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE frozen_transaction_selections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_transaction_views, frozen_transaction_selections TO moneo_app;
--> statement-breakpoint
CREATE POLICY saved_transaction_views_isolation ON saved_transaction_views FOR ALL TO moneo_app USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY frozen_transaction_selections_isolation ON frozen_transaction_selections FOR ALL TO moneo_app USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
