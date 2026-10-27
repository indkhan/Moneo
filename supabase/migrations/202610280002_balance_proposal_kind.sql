-- Re-applies the balance_set proposal kind under a new version: 202610270005 is already recorded remotely under another name, so it never ran.
alter table public.agent_proposals drop constraint agent_proposals_kind_check;
alter table public.agent_proposals add constraint agent_proposals_kind_check check (kind in ('categorize','recurring','budget','finding','iou_create','iou_settle','transaction_create','balance_set'));
drop policy own_agent_proposals_standalone_insert on public.agent_proposals;
create policy own_agent_proposals_standalone_insert on public.agent_proposals for insert to authenticated
  with check (public.owns_workspace(workspace_id) and run_id is null and kind in ('iou_create','iou_settle','transaction_create','balance_set') and status = 'proposed');
