-- What the owner does on the Organize page and in chat cards.

-- A chat card that answers an organize question or sets what a payee is (accepted like any other standalone card).
alter table public.agent_proposals drop constraint agent_proposals_kind_check;
alter table public.agent_proposals add constraint agent_proposals_kind_check check (kind in ('categorize','recurring','budget','finding','iou_create','iou_settle','transaction_create','balance_set','recurring_edit','scalable_order','scalable_cancel','own_transfer','cash_withdrawal','organize_answer'));

-- "Looks right": the owner checks AI labels and keeps them. Each row becomes the owner's own organization, so the
-- calibration check counts it as a right label and the organizer never relabels it. The labels themselves are untouched
-- (no version change, no correction event) and organizer_ops keeps the record of what the AI wrote.
create function public.confirm_ai_organization(p_transaction_ids uuid[]) returns integer language plpgsql security definer set search_path='' as $$
declare confirmed integer;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_transaction_ids is null or cardinality(p_transaction_ids) not between 1 and 500 then raise exception 'Choose AI labels to confirm' using errcode='22023'; end if;
  perform 1 from public.transactions where id=any(p_transaction_ids) and organized_by='ai' and public.owns_workspace(workspace_id) order by id for update;
  update public.transactions set organized_by='owner',ai_confidence=null,ai_reason=null,organize_op_id=null
    where id=any(p_transaction_ids) and organized_by='ai' and public.owns_workspace(workspace_id);
  get diagnostics confirmed = row_count;
  return confirmed;
end;
$$;
revoke all on function public.confirm_ai_organization(uuid[]) from public,anon;
grant execute on function public.confirm_ai_organization(uuid[]) to authenticated;

-- The owner takes back what they told the organizer about a payee. Rows already labelled from it keep their labels and
-- their batch Undo; only the memory (what future rows of this payee are labelled from) goes.
create function public.remove_organize_memory(p_memory uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  delete from public.organize_memory where id=p_memory and public.owns_workspace(workspace_id);
  if not found then raise exception 'Memory not found' using errcode='P0002'; end if;
end;
$$;
revoke all on function public.remove_organize_memory(uuid) from public,anon;
grant execute on function public.remove_organize_memory(uuid) to authenticated;
