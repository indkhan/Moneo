-- E03-S03: Historical FX valuation with ECB triangulation and manual-rate fallback.
-- Native booked amounts remain canonical. FX valuation carries explicit source/date/version evidence.
-- Composite tenant keys, FORCE RLS, exact minor-unit BigInt arithmetic.

-- ECB reference rates cache: one row per date, base=EUR, target currency.
-- source_hash: SHA256 of the raw ECB XML for that date (for checksum verification).
-- checksum: ECB-provided checksum if available; otherwise empty string.
-- rate: exact ECB decimal rate as string (target major units per 1 EUR major unit, e.g., "1.1460")
CREATE TABLE IF NOT EXISTS fx_rates_ecb (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  rate_date DATE NOT NULL,
  target_currency CHAR(3) NOT NULL CONSTRAINT fx_rates_ecb_currency_fmt CHECK (target_currency ~ '^[A-Z]{3}$'),
  rate TEXT NOT NULL, -- exact ECB rate string, e.g., "1.1460"
  source_hash CHAR(64) NOT NULL, -- SHA256 of raw ECB XML fragment for this date
  checksum TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, rate_date, target_currency),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS fx_rates_ecb_date_idx ON fx_rates_ecb (workspace_id, rate_date DESC);

-- Manual rate overrides: audited, dated, take precedence over ECB for specific date/currency pair.
-- base_currency is the source (e.g., EUR), target_currency is the destination.
-- rate: exact decimal rate as string (target major units per 1 base major unit)
CREATE TABLE IF NOT EXISTS fx_rates_manual (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  rate_date DATE NOT NULL,
  base_currency CHAR(3) NOT NULL CONSTRAINT fx_rates_manual_base_fmt CHECK (base_currency ~ '^[A-Z]{3}$'),
  target_currency CHAR(3) NOT NULL CONSTRAINT fx_rates_manual_target_fmt CHECK (target_currency ~ '^[A-Z]{3}$'),
  rate TEXT NOT NULL, -- exact rate string, e.g., "1.1460"
  auditor TEXT NOT NULL CONSTRAINT fx_rates_manual_auditor_len CHECK (char_length(auditor) BETWEEN 1 AND 200),
  source TEXT NOT NULL CONSTRAINT fx_rates_manual_source_len CHECK (char_length(source) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, rate_date, base_currency, target_currency),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS fx_rates_manual_date_idx ON fx_rates_manual (workspace_id, rate_date DESC);

-- FX valuations of balance snapshots: native amount * rate = base-currency minor units.
-- Coverage: 'full' (rate found for date), 'partial' (latest prior rate within max age), 'unavailable' (no rate).
-- max_prior_rate_age_days: age in days of the latest prior rate used (null if full coverage).
-- calculation_version: references calculation_versions for reproducibility.
CREATE TABLE IF NOT EXISTS fx_valuation (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  snapshot_id UUID NOT NULL,
  base_currency CHAR(3) NOT NULL CONSTRAINT fx_valuation_base_fmt CHECK (base_currency ~ '^[A-Z]{3}$'),
  valued_amount_minor BIGINT NOT NULL, -- signed, in base currency minor units
  coverage TEXT NOT NULL CONSTRAINT fx_valuation_coverage CHECK (coverage IN ('full', 'partial', 'unavailable')),
  max_prior_rate_age_days INTEGER NULL,
  rate_date DATE NULL, -- actual rate date used (may differ from snapshot as_of_date for partial)
  rate_source TEXT NOT NULL CONSTRAINT fx_valuation_source CHECK (rate_source IN ('ecb', 'manual', 'identity')),
  calculation_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, snapshot_id, base_currency),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES balance_snapshots (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, calculation_version) REFERENCES calculation_versions (workspace_id, version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS fx_valuation_snapshot_idx ON fx_valuation (workspace_id, snapshot_id);
CREATE INDEX IF NOT EXISTS fx_valuation_calc_version_idx ON fx_valuation (workspace_id, calculation_version);

-- RLS policies: strict workspace equality
ALTER TABLE fx_rates_ecb ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates_ecb FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_rates_ecb_isolation ON fx_rates_ecb;
CREATE POLICY fx_rates_ecb_isolation ON fx_rates_ecb
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE fx_rates_manual ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates_manual FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_rates_manual_isolation ON fx_rates_manual;
CREATE POLICY fx_rates_manual_isolation ON fx_rates_manual
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

ALTER TABLE fx_valuation ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_valuation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_valuation_isolation ON fx_valuation;
CREATE POLICY fx_valuation_isolation ON fx_valuation
  USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);