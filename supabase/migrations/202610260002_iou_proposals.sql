-- Money lent to or borrowed from a person is proposed first (from chat or from a bank-feed match)
-- and only written to Wealth when the owner accepts. These proposals belong to no agent run.
alter table public.agent_proposals alter column run_id drop not null;
alter table public.agent_proposals drop constraint agent_proposals_kind_check;
alter table public.agent_proposals add constraint agent_proposals_kind_check check (kind in ('categorize','recurring','budget','finding','iou_create','iou_settle'));
-- One proposal per match, ever: a dismissed repayment is not suggested again.
create unique index agent_proposals_standalone_conflict_key on public.agent_proposals(workspace_id, conflict_key) where run_id is null;
create policy own_agent_proposals_standalone_insert on public.agent_proposals for insert to authenticated
  with check (public.owns_workspace(workspace_id) and run_id is null and kind in ('iou_create','iou_settle') and status = 'proposed');
grant insert (workspace_id, agent, kind, conflict_key, title, detail, evidence, payload, confidence, notes) on public.agent_proposals to authenticated;
