-- The Categorizer sizes a run's model budget from its backlog (one call per
-- 50 unique descriptions), so the ceiling is a runaway guard, not a work cap.
alter table public.agent_runs drop constraint agent_runs_budget_check;
alter table public.agent_runs add constraint agent_runs_budget_check
  check (model_budget between 0 and 200 and model_calls between 0 and model_budget);
