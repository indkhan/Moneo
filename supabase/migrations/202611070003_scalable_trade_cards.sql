-- Chat can show Scalable order and order-cancel cards. The card holds Scalable's preview; only the owner's
-- tap on it submits the order (lib/scalable/orders.ts), so these rows are created like other chat cards.
alter table public.agent_proposals drop constraint agent_proposals_kind_check;
alter table public.agent_proposals add constraint agent_proposals_kind_check check (kind in ('categorize','recurring','budget','finding','iou_create','iou_settle','transaction_create','balance_set','recurring_edit','scalable_order','scalable_cancel'));
drop policy own_agent_proposals_standalone_insert on public.agent_proposals;
create policy own_agent_proposals_standalone_insert on public.agent_proposals for insert to authenticated
  with check (public.owns_workspace(workspace_id) and run_id is null and kind in ('iou_create','iou_settle','transaction_create','balance_set','recurring_edit','scalable_order','scalable_cancel') and status = 'proposed');
