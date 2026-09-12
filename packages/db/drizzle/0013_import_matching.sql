-- Epoch 4, Issue 4.11 — overlapping import matching and resolution.
--
-- Trust model (§537): retry identity ((workspace, import, row)) and file
-- hashes (duplicate signal only) already exist. This table stages the two
-- remaining cases durably: trusted external-identity hits (auto-linked, no
-- new canonical) and conservative fuzzy candidates (ambiguous rows stay
-- OUTSIDE accepted canonical totals until the user resolves them).
--
-- No fuzzy-field uniqueness anywhere: two legitimate identical purchases
-- stay distinct rows; multiplicity is preserved because one existing row
-- never absorbs new rows automatically. Resolution (`matches.resolve`)
-- links (MERGED, preserving prior canonical corrections and both source
-- observations) or keeps distinct (new canonical + PRIMARY link) through
-- audited, idempotent commands. E7 reuses the same rows in Review.
CREATE TABLE import_match_candidates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  import_id uuid NOT NULL REFERENCES imports (id) ON DELETE CASCADE,
  data_source_id uuid NOT NULL REFERENCES data_sources (id) ON DELETE CASCADE,
  source_transaction_id uuid NOT NULL REFERENCES source_transactions (id) ON DELETE CASCADE,
  candidate_transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  match_rule text NOT NULL,
  match_version text NOT NULL DEFAULT 'v1',
  confidence text NOT NULL DEFAULT 'review',
  status text NOT NULL DEFAULT 'pending',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT import_match_candidates_pair_uniq UNIQUE (source_transaction_id, candidate_transaction_id),
  CONSTRAINT import_match_candidates_rule_check CHECK (match_rule in ('trusted-external-id', 'fuzzy-date-amount-description')),
  CONSTRAINT import_match_candidates_confidence_check CHECK (confidence in ('auto', 'review')),
  CONSTRAINT import_match_candidates_status_check CHECK (status in ('pending', 'linked', 'distinct'))
);
--> statement-breakpoint
CREATE INDEX import_match_candidates_import_status_idx ON import_match_candidates USING btree (import_id, status);
--> statement-breakpoint
CREATE INDEX import_match_candidates_workspace_created_idx ON import_match_candidates USING btree (workspace_id, created_at);
--> statement-breakpoint
ALTER TABLE import_match_candidates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE import_match_candidates TO moneo_app;
--> statement-breakpoint
CREATE POLICY import_match_candidates_isolation ON import_match_candidates FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
