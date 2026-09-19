-- Rollback for E03-S03 FX valuation tables
DROP POLICY IF EXISTS fx_valuation_isolation ON fx_valuation;
DROP POLICY IF EXISTS fx_rates_manual_isolation ON fx_rates_manual;
DROP POLICY IF EXISTS fx_rates_ecb_isolation ON fx_rates_ecb;

DROP TABLE IF EXISTS fx_valuation;
DROP TABLE IF EXISTS fx_rates_manual;
DROP TABLE IF EXISTS fx_rates_ecb;