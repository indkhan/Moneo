-- A bank sync starts one agent run after all its accounts are in, and the hourly backlog check
-- starts one when rows still lack a merchant or category after a failed run or newer rows.
alter table public.agent_runs drop constraint agent_runs_trigger_check;
alter table public.agent_runs add constraint agent_runs_trigger_check check (trigger in ('import','manual','sync','backlog'));
