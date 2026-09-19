-- E04-S06: AI settings and usage tracking
-- (product AI settings/financial exclusions; architecture §§124-138).
-- Reuses existing ai_policies, ai_exclusions, ai_dispatch_permits, ai_dispatch_budgets,
-- ai_dispatch_reservations, ai_dispatch_usage from E04-S01/E01-S05.
-- No new tables needed; this story exposes existing data via settings UI.
-- Composite keys per §27; FORCE RLS per §23.

-- No new tables; settings are derived from existing tables:
-- - ai_policies (policy_version, exclusions)
-- - ai_dispatch_budgets (money_budget_minor, token_budget, concurrency_limit)
-- - ai_dispatch_reservations (reserved cost, input_estimate, output_ceiling, status)
-- - ai_dispatch_usage (reconciled cost, input/output tokens, error_class)
-- - ai_exclusions (account-level exclusions)
-- - ai_policies (policy_version)

-- View for settings page: aggregates usage stats per workspace
CREATE OR REPLACE VIEW ai_settings_usage AS
SELECT
  b.workspace_id,
  b.money_budget_minor,
  b.token_budget,
  b.concurrency_limit,
  COALESCE(SUM(CASE WHEN r.status = 'RESERVED' THEN r.reserved_cost_minor ELSE 0 END), 0) AS reserved_money_minor,
  COALESCE(SUM(CASE WHEN r.status = 'RESERVED' THEN r.input_estimate ELSE 0 END), 0) AS reserved_input_tokens,
  COALESCE(SUM(CASE WHEN r.status = 'RESERVED' THEN r.output_ceiling ELSE 0 END), 0) AS reserved_output_tokens,
  COALESCE(SUM(CASE WHEN u.status = 'RECONCILED' THEN u.reconciled_cost_minor ELSE 0 END), 0) AS reconciled_money_minor,
  COALESCE(SUM(CASE WHEN u.status = 'RECONCILED' THEN u.input_tokens ELSE 0 END), 0) AS reconciled_input_tokens,
  COALESCE(SUM(CASE WHEN u.status = 'RECONCILED' THEN u.output_tokens ELSE 0 END), 0) AS reconciled_output_tokens,
  COALESCE(SUM(CASE WHEN u.status = 'PENDING' THEN r.reserved_cost_minor ELSE 0 END), 0) AS pending_money_minor,
  COALESCE(SUM(CASE WHEN u.status = 'PENDING' THEN u.input_tokens ELSE 0 END), 0) AS pending_input_tokens,
  COALESCE(SUM(CASE WHEN u.status = 'PENDING' THEN u.output_tokens ELSE 0 END), 0) AS pending_output_tokens,
  COALESCE(COUNT(CASE WHEN u.status = 'PENDING' THEN 1 END), 0) AS pending_count,
  COALESCE(COUNT(CASE WHEN u.status = 'RECONCILED' THEN 1 END), 0) AS reconciled_count,
  COALESCE(COUNT(CASE WHEN u.status = 'RELEASED' THEN 1 END), 0) AS released_count
FROM ai_dispatch_budgets b
LEFT JOIN ai_dispatch_reservations r ON r.workspace_id = b.workspace_id
LEFT JOIN ai_dispatch_usage u ON u.workspace_id = b.workspace_id AND u.reservation_id = r.id
GROUP BY b.workspace_id, b.money_budget_minor, b.token_budget, b.concurrency_limit;