-- Keep each overlap decision after reopening its source observation.
create table public.import_row_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.source_transactions(id) on delete cascade,
  action text not null check(action in ('accepted','rejected')),
  source_record jsonb not null,
  transaction_record jsonb,
  balance_records jsonb not null default '[]',
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null
);
create unique index import_row_decisions_active on public.import_row_decisions(source_id) where undone_at is null;
create index import_row_decisions_workspace on public.import_row_decisions(workspace_id,source_id);
alter table public.import_row_decisions enable row level security;
create policy import_row_decisions_read on public.import_row_decisions for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.import_row_decisions from public,anon,authenticated;
grant select on public.import_row_decisions to authenticated;

create function public.audit_import_row_decision() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.status in ('review','new') and new.status in ('accepted','rejected') and not ('excluded_by_review'=any(new.review_reasons)) then
    insert into public.import_row_decisions(workspace_id,source_id,action,source_record,transaction_record,balance_records,actor_id)
    values(new.workspace_id,new.id,new.status,to_jsonb(new),
      (select to_jsonb(t) from public.transactions t join public.transaction_sources l on l.transaction_id=t.id where l.source_transaction_id=new.id),
      (select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]'::jsonb) from public.balance_snapshots b where b.source_transaction_id=new.id),auth.uid());
  end if;
  return new;
end;
$$;
create trigger source_transaction_review_history after update of status on public.source_transactions for each row execute function public.audit_import_row_decision();
revoke all on function public.audit_import_row_decision() from public,anon,authenticated;

create function public.undo_import_row_decision(p_decision_id uuid) returns public.source_transactions
language plpgsql security definer set search_path='' as $$
declare decision public.import_row_decisions%rowtype; source public.source_transactions%rowtype;
  imported public.imports%rowtype; target_id uuid; transaction_record jsonb; balances jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into decision from public.import_row_decisions where id=p_decision_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Review history not found' using errcode='P0002'; end if;
  select * into strict source from public.source_transactions where id=decision.source_id;
  target_id:=(decision.transaction_record->>'id')::uuid;
  -- Match the canonical-before-import-before-source order used by acceptance.
  perform id from public.transactions where id=target_id for update;
  select * into strict imported from public.imports where id=source.import_id for update;
  select * into strict source from public.source_transactions where id=decision.source_id for update;
  select * into strict decision from public.import_row_decisions where id=p_decision_id for update;
  if imported.status<>'completed' then raise exception 'Import is not completed' using errcode='PT409'; end if;
  if decision.undone_at is not null then
    if source.status='review' then return source; end if;
    raise exception 'Review decision changed; refresh and retry' using errcode='PT409';
  end if;
  if source.status is distinct from decision.action or to_jsonb(source) is distinct from decision.source_record then
    raise exception 'Review decision changed; refresh and retry' using errcode='PT409';
  end if;
  if 'excluded_by_review'=any(source.review_reasons) then raise exception 'Excluded source observation cannot be reopened' using errcode='22023'; end if;
  if decision.action='accepted' then
    select to_jsonb(t) into transaction_record from public.transactions t where t.id=target_id and t.workspace_id=decision.workspace_id;
    if transaction_record is null or transaction_record is distinct from decision.transaction_record then
      raise exception 'Undo later transaction changes before reopening this row' using errcode='PT409';
    end if;
    if exists(select 1 from public.correction_events where transaction_id=target_id)
      or exists(select 1 from public.recurring_series_transactions where transaction_id=target_id)
      or exists(select 1 from public.recurring_occurrence_settlements where transaction_id=target_id and undone_at is null)
      or exists(select 1 from public.transaction_split_sets where transaction_id=target_id)
      or exists(select 1 from public.transaction_links where primary_transaction_id=target_id or counterpart_transaction_id=target_id)
      or exists(select 1 from public.transaction_link_fees where transaction_id=target_id)
      or exists(select 1 from public.pending_hold_resolutions where undone_at is null and (pending_transaction_id=target_id or posted_transaction_id=target_id))
      or exists(select 1 from public.transactions t where (t.id=target_id and (t.transfer_id is not null or t.refund_of_id is not null)) or t.refund_of_id=target_id or t.transfer_id=target_id) then
      raise exception 'Undo dependent corrections, recurring matches, links or pending resolutions before reopening this row' using errcode='PT409';
    end if;
    if not exists(select 1 from public.transaction_sources l where l.transaction_id=target_id and l.source_transaction_id=source.id)
      or exists(select 1 from public.transaction_sources l where l.transaction_id=target_id and l.source_transaction_id<>source.id) then
      raise exception 'This transaction has other source evidence; open Transactions to review it' using errcode='PT409';
    end if;
    if exists(select 1 from public.balance_snapshots b where b.workspace_id=decision.workspace_id and b.undone_at is null
      and exists(select 1 from jsonb_array_elements(coalesce(b.covered_transactions,'[]'::jsonb)) covered where covered->>'id'=target_id::text)) then
      raise exception 'Undo dependent reviewed balances in Accounts before reopening this row' using errcode='PT409';
    end if;
    perform id from public.balance_snapshots where source_transaction_id=source.id order by id for update;
    select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]'::jsonb) into balances from public.balance_snapshots b where b.source_transaction_id=source.id;
    if balances is distinct from decision.balance_records then raise exception 'Balance evidence changed; review it in Accounts first' using errcode='PT409'; end if;
    delete from public.balance_snapshots where source_transaction_id=source.id;
    delete from public.transaction_sources l where l.transaction_id=target_id and l.source_transaction_id=source.id;
    delete from public.transactions where id=target_id;
  end if;
  update public.import_row_decisions set undone_at=clock_timestamp(),undone_by=auth.uid() where id=decision.id;
  update public.source_transactions set status='review',normalized_row=normalized_row-'resolution' where id=source.id returning * into source;
  perform public.recount_import_progress(imported.id);
  return source;
end;
$$;
revoke all on function public.undo_import_row_decision(uuid) from public,anon;
grant execute on function public.undo_import_row_decision(uuid) to authenticated;
