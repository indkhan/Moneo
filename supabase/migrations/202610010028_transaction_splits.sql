-- Canonical transactions retain source money. Effective spending substitutes exact allocations.
create table public.transaction_split_sets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  transaction_id uuid not null references public.transactions(id),
  request_id uuid not null,
  actor_id uuid not null references auth.users(id),
  before jsonb not null,
  after jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id),
  unique(workspace_id,request_id)
);
create unique index transaction_split_sets_one_active on public.transaction_split_sets(transaction_id) where undone_at is null;
create table public.transaction_splits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  parent_transaction_id uuid not null references public.transactions(id),
  split_set_id uuid not null references public.transaction_split_sets(id),
  category_id uuid references public.categories(id),
  amount_minor bigint not null check(amount_minor<>0),
  note text not null default '' check(char_length(note)<=500),
  ordinal integer not null check(ordinal between 1 and 20),
  unique(split_set_id,ordinal)
);
alter table public.transaction_split_sets enable row level security;
alter table public.transaction_splits enable row level security;
create policy transaction_split_sets_owner_select on public.transaction_split_sets for select to authenticated using(public.owns_workspace(workspace_id));
create policy transaction_splits_owner_select on public.transaction_splits for select to authenticated using(public.owns_workspace(workspace_id));
grant select on public.transaction_split_sets,public.transaction_splits to authenticated;
revoke insert,update,delete on public.transaction_split_sets,public.transaction_splits from authenticated;

create view public.effective_transactions with (security_invoker=true) as
select p.id,p.id as parent_transaction_id,p.workspace_id,p.account_id,p.posted_on,p.posted_at,p.description,p.amount_minor,p.currency_code,p.status,p.kind,p.category_id,p.merchant_id,p.note,p.transfer_id,p.refund_of_id,p.version,p.created_at,p.tags,p.event_name,p.review_reasons
from public.transactions p where not exists(select 1 from public.transaction_split_sets sets where sets.transaction_id=p.id and sets.undone_at is null)
union all
select s.id,p.id as parent_transaction_id,p.workspace_id,p.account_id,p.posted_on,p.posted_at,p.description,s.amount_minor,p.currency_code,p.status,p.kind,s.category_id,p.merchant_id,s.note,p.transfer_id,p.refund_of_id,p.version,p.created_at,p.tags,p.event_name,p.review_reasons
from public.transactions p join public.transaction_splits s on s.parent_transaction_id=p.id and s.workspace_id=p.workspace_id
join public.transaction_split_sets sets on sets.id=s.split_set_id and sets.transaction_id=p.id and sets.workspace_id=p.workspace_id and sets.undone_at is null;
grant select on public.effective_transactions to authenticated,service_role;

create function public.guard_split_transaction() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.transaction_split_sets where transaction_id=old.id and undone_at is null) and
    (new.amount_minor,new.currency_code,new.account_id,new.posted_on,new.posted_at,new.status,new.kind,new.category_id,new.transfer_id,new.refund_of_id,new.review_reasons)
    is distinct from (old.amount_minor,old.currency_code,old.account_id,old.posted_on,old.posted_at,old.status,old.kind,old.category_id,old.transfer_id,old.refund_of_id,old.review_reasons)
    then raise exception 'Undo splits before changing source classification, category or links' using errcode='22023'; end if;
  -- Inbound refund links also need a deliberate category allocation, never the hidden parent category.
  if new.refund_of_id is not null and exists(select 1 from public.transaction_split_sets where transaction_id=new.refund_of_id and undone_at is null)
    then raise exception 'Undo original transaction splits before linking a refund' using errcode='22023'; end if;
  return new;
end;
$$;
create trigger transactions_split_guard before insert or update on public.transactions for each row execute function public.guard_split_transaction();

create function public.split_transaction(p_transaction_id uuid,p_expected_version integer,p_children jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare parent public.transactions%rowtype; prior public.transaction_split_sets%rowtype; child jsonb; total numeric:=0; split_id uuid:=gen_random_uuid(); normalized jsonb:='[]'; child_amount bigint; child_category uuid; position integer:=0;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_request_id is null or p_children is null or jsonb_typeof(p_children)<>'array' or jsonb_array_length(p_children) not between 2 and 20 then raise exception 'Two to twenty exact allocations required' using errcode='22023'; end if;
  select * into parent from public.transactions where id=p_transaction_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Transaction not found' using errcode='P0002'; end if;
  for child in select value from jsonb_array_elements(p_children) loop
    if jsonb_typeof(child)<>'object' or child-array['amount_minor','category_id','note']<>'{}'::jsonb or jsonb_typeof(child->'amount_minor') is distinct from 'string'
      or child->>'amount_minor' !~ '^-?[0-9]{1,19}$' or jsonb_typeof(child->'note') is distinct from 'string' or char_length(child->>'note')>500
      or not(child ? 'category_id') or jsonb_typeof(child->'category_id') not in ('string','null') then raise exception 'Invalid allocation' using errcode='22023'; end if;
    begin child_amount:=(child->>'amount_minor')::bigint; child_category:=(child->>'category_id')::uuid;
    exception when numeric_value_out_of_range or invalid_text_representation then raise exception 'Invalid allocation money or category' using errcode='22023'; end;
    if child_amount=0 or sign(child_amount)<>sign(parent.amount_minor) then raise exception 'Allocations must have the source amount direction' using errcode='22023'; end if;
    if child_category is not null and not exists(select 1 from public.categories where id=child_category and workspace_id=parent.workspace_id) then raise exception 'Category not found' using errcode='P0002'; end if;
    total:=total+child_amount;
    normalized:=normalized||jsonb_build_array(jsonb_build_object('amount_minor',child_amount::text,'category_id',child_category,'note',btrim(child->>'note')));
  end loop;
  if total<>parent.amount_minor then raise exception 'Allocation total must exactly equal the source amount' using errcode='22023'; end if;
  select * into prior from public.transaction_split_sets where workspace_id=parent.workspace_id and request_id=p_request_id;
  if found then
    if prior.transaction_id<>parent.id or prior.after->'children' is distinct from normalized then raise exception 'Request ID reused for another split' using errcode='22023'; end if;
    return jsonb_build_object('setId',prior.id,'undone',prior.undone_at is not null);
  end if;
  if parent.version is distinct from p_expected_version then raise exception 'Transaction changed; refresh before splitting' using errcode='40001'; end if;
  if parent.kind<>'ordinary' or parent.status<>'posted' or cardinality(parent.review_reasons)>0 or parent.transfer_id is not null or parent.refund_of_id is not null
    or exists(select 1 from public.transactions where transfer_id=parent.id or refund_of_id=parent.id)
    or exists(select 1 from public.transaction_split_sets where transaction_id=parent.id and undone_at is null)
    then raise exception 'Only reviewed posted ordinary unlinked transactions can be split; undo existing splits first' using errcode='22023'; end if;
  insert into public.transaction_split_sets(id,workspace_id,transaction_id,request_id,actor_id,before,after)
    values(split_id,parent.workspace_id,parent.id,p_request_id,auth.uid(),jsonb_build_object('amount_minor',parent.amount_minor::text,'category_id',parent.category_id,'version',parent.version),jsonb_build_object('children',normalized,'version',parent.version+1));
  for child in select value from jsonb_array_elements(normalized) loop
    position:=position+1;
    insert into public.transaction_splits(workspace_id,parent_transaction_id,split_set_id,category_id,amount_minor,note,ordinal)
      values(parent.workspace_id,parent.id,split_id,(child->>'category_id')::uuid,(child->>'amount_minor')::bigint,child->>'note',position);
  end loop;
  update public.transactions set version=version+1 where id=parent.id;
  insert into public.correction_events(workspace_id,transaction_id,actor_id,before,after)
    values(parent.workspace_id,parent.id,auth.uid(),jsonb_build_object('version',parent.version),jsonb_build_object('operation','split','split_set_id',split_id,'version',parent.version+1));
  return jsonb_build_object('setId',split_id,'undone',false);
end;
$$;

create function public.undo_transaction_splits(p_set_id uuid,p_expected_version integer)
returns void language plpgsql security definer set search_path='' as $$
declare allocation public.transaction_split_sets%rowtype; parent public.transactions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into allocation from public.transaction_split_sets where id=p_set_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Split allocation not found' using errcode='P0002'; end if;
  select * into parent from public.transactions where id=allocation.transaction_id and workspace_id=allocation.workspace_id for update;
  select * into allocation from public.transaction_split_sets where id=p_set_id for update;
  if allocation.undone_at is not null then return; end if;
  if parent.version is distinct from p_expected_version then raise exception 'Transaction changed; refresh before undoing splits' using errcode='40001'; end if;
  update public.transaction_split_sets set undone_at=now(),undone_by=auth.uid() where id=allocation.id;
  update public.transactions set version=version+1 where id=parent.id;
  update public.correction_events set undone=true where transaction_id=parent.id and after->>'split_set_id'=allocation.id::text;
end;
$$;
revoke all on function public.split_transaction(uuid,integer,jsonb,uuid),public.undo_transaction_splits(uuid,integer),public.guard_split_transaction() from public;
grant execute on function public.split_transaction(uuid,integer,jsonb,uuid),public.undo_transaction_splits(uuid,integer) to authenticated;
