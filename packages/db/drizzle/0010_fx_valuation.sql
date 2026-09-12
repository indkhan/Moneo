-- Epoch 4, Issue 4.9 — historical FX and transaction valuation.
--
-- Native amounts (`transactions.amount_minor`, direction, currency) stay
-- canonical: conversions are rebuildable projections in
-- `transaction_valuations`, never rewrites. `fx_rates` is the versioned
-- rate cache: one row per (base, quote, date, source). Seed rows
-- (source `seed`) and user-supplied dated rates (source `manual`) share the
-- table; every row carries its own provenance so aggregates and AI evidence
-- can cite rate date/source/calculation version.
--
-- Base currency lives on `workspaces.base_currency` (default EUR): changing
-- it schedules valuation rebuilds (Issue 4.9 service) without touching
-- native rows. Missing rates are ABSENT rows — aggregates report incomplete
-- coverage, never a zero or a silently substituted rate.
CREATE TABLE fx_rates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  base_currency_code text NOT NULL,
  quote_currency_code text NOT NULL,
  rate_date date NOT NULL,
  rate numeric(30, 15) NOT NULL,
  source text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT fx_rates_pair_check CHECK (base_currency_code <> quote_currency_code),
  CONSTRAINT fx_rates_rate_check CHECK (rate > 0),
  CONSTRAINT fx_rates_source_check CHECK (source in ('seed', 'manual')),
  CONSTRAINT fx_rates_pair_date_source_uniq UNIQUE (workspace_id, base_currency_code, quote_currency_code, rate_date, source)
);
--> statement-breakpoint
CREATE TABLE transaction_valuations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  target_currency_code text NOT NULL,
  rate numeric(30, 15) NOT NULL,
  rate_date date NOT NULL,
  rate_source text NOT NULL,
  converted_amount_minor bigint NOT NULL,
  calculation_version text NOT NULL DEFAULT 'v1',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT transaction_valuations_pair_date_source_version_uniq UNIQUE (transaction_id, target_currency_code, rate_date, rate_source, calculation_version)
);
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN base_currency text NOT NULL DEFAULT 'EUR';
--> statement-breakpoint
CREATE INDEX fx_rates_workspace_pair_date_idx ON fx_rates USING btree (workspace_id, base_currency_code, quote_currency_code, rate_date DESC);
--> statement-breakpoint
CREATE INDEX transaction_valuations_transaction_target_idx ON transaction_valuations USING btree (transaction_id, target_currency_code);
--> statement-breakpoint
CREATE INDEX transaction_valuations_workspace_created_idx ON transaction_valuations USING btree (workspace_id, created_at);
--> statement-breakpoint
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transaction_valuations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fx_rates, transaction_valuations TO moneo_app;
--> statement-breakpoint
CREATE POLICY fx_rates_isolation ON fx_rates FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY transaction_valuations_isolation ON transaction_valuations FOR ALL TO moneo_app
  USING (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace', true), '')::uuid);
