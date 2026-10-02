-- Dated owned comparison evidence never relabels or rescales canonical postings.
create table public.transaction_links (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  primary_transaction_id uuid not null references public.transactions(id), counterpart_transaction_id uuid not null references public.transactions(id),
  operation text not null check(operation in ('transfer','refund')), request_id uuid not null,
  input jsonb not null, before_rows jsonb not null, after_rows jsonb not null, fx_evidence jsonb,
  original_equivalent_minor bigint, actor_id uuid not null references auth.users(id), created_at timestamptz not null default now(),
  undone_at timestamptz, undone_by uuid references auth.users(id), unique(workspace_id,request_id)
);
create unique index transaction_links_active_primary on public.transaction_links(primary_transaction_id) where undone_at is null;
create table public.transaction_link_fees (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id), link_id uuid not null references public.transaction_links(id),
  transaction_id uuid not null references public.transactions(id), fee_minor bigint not null check(fee_minor>0), treatment text not null check(treatment in ('included','additional')),
  category_id uuid references public.categories(id), note text not null check(length(btrim(note)) between 1 and 500), unique(link_id,transaction_id)
);
alter table public.transaction_links enable row level security;
alter table public.transaction_link_fees enable row level security;
create policy transaction_links_owned on public.transaction_links for select to authenticated using(public.owns_workspace(workspace_id));
create policy transaction_link_fees_owned on public.transaction_link_fees for select to authenticated using(public.owns_workspace(workspace_id));
grant select on public.transaction_links,public.transaction_link_fees to authenticated,service_role;
revoke insert,update,delete on public.transaction_links,public.transaction_link_fees from authenticated;

create function public.link_money_snapshot(p public.transactions) returns jsonb language sql immutable set search_path='' as $$
 select to_jsonb(p)||jsonb_build_object('amount_minor',p.amount_minor::text)
$$;
-- Positive integer comparison with exact half-up rounding; numeric division must not round a fractional threshold first.
create function public.link_fx_minor(p_amount numeric,p_from text,p_to text,p_rate public.fx_rates) returns numeric language plpgsql immutable set search_path='' as $$
declare numerator numeric; denominator numeric; digits_from integer:=public.currency_minor_digits(p_from); digits_to integer:=public.currency_minor_digits(p_to); rate_numerator numeric; rate_denominator numeric;
begin
  if p_amount<0 or digits_from is null or digits_to is null then raise exception 'Unsupported exact comparison currency' using errcode='22023'; end if;
  if p_from=p_to then return p_amount; end if;
  if p_rate.id is null then raise exception 'Dated FX evidence required' using errcode='22023'; end if;
  rate_numerator:=replace(p_rate.rate_text,'.','')::numeric; rate_denominator:=power(10::numeric,length(split_part(p_rate.rate_text,'.',2)));
  if p_rate.from_currency=p_from and p_rate.to_currency=p_to then numerator:=p_amount*rate_numerator*power(10::numeric,digits_to); denominator:=rate_denominator*power(10::numeric,digits_from);
  elsif p_rate.from_currency=p_to and p_rate.to_currency=p_from then numerator:=p_amount*rate_denominator*power(10::numeric,digits_to); denominator:=rate_numerator*power(10::numeric,digits_from);
  else raise exception 'FX currency pair does not match postings' using errcode='22023'; end if;
  return div(numerator*2+denominator,denominator*2);
end;
$$;

create function public.guard_verified_transaction_link() returns trigger language plpgsql security definer set search_path='' as $$
declare original public.transactions%rowtype; refunded numeric;
begin
  if current_setting('moneo.link_edit',true) is distinct from 'on' and exists(select 1 from public.transactions where refund_of_id=old.id)
    and (new.kind,new.status,new.amount_minor,new.account_id,new.currency_code,new.posted_on,new.posted_at,new.transfer_id,new.refund_of_id,new.review_reasons)
      is distinct from (old.kind,old.status,old.amount_minor,old.account_id,old.currency_code,old.posted_on,old.posted_at,old.transfer_id,old.refund_of_id,old.review_reasons)
    then raise exception 'Undo linked refunds before changing original financial evidence' using errcode='22023'; end if;
  if current_setting('moneo.link_edit',true) is distinct from 'on' and new.refund_of_id is not null and new.refund_of_id is distinct from old.refund_of_id then
    select * into original from public.transactions where id=new.refund_of_id and workspace_id=new.workspace_id for update;
    if not found or original.currency_code<>new.currency_code then raise exception 'Use the verified refund action with dated FX evidence' using errcode='22023'; end if;
    select coalesce(sum(case when l.id is not null then l.original_equivalent_minor::numeric else t.amount_minor::numeric end),0) into refunded
      from public.transactions t left join public.transaction_links l on l.primary_transaction_id=t.id and l.operation='refund' and l.undone_at is null where t.refund_of_id=original.id and t.id<>new.id;
    if refunded+new.amount_minor>abs(original.amount_minor::numeric) then raise exception 'Combined refunds exceed the original expense' using errcode='22023'; end if;
  end if;
  if current_setting('moneo.link_edit',true) is distinct from 'on' and exists(select 1 from public.transaction_links l where l.undone_at is null and (l.primary_transaction_id=old.id or (l.operation='transfer' and l.counterpart_transaction_id=old.id)))
    and (new.kind,new.status,new.amount_minor,new.account_id,new.currency_code,new.posted_on,new.posted_at,new.transfer_id,new.refund_of_id,new.review_reasons)
      is distinct from (old.kind,old.status,old.amount_minor,old.account_id,old.currency_code,old.posted_on,old.posted_at,old.transfer_id,old.refund_of_id,old.review_reasons)
    then raise exception 'Undo the verified link before changing its financial classification' using errcode='22023'; end if;
  return new;
end;
$$;
create trigger transactions_verified_link_guard before update on public.transactions for each row execute function public.guard_verified_transaction_link();

create function public.link_transactions(p_operation text,p_primary_id uuid,p_expected_version integer,p_other_id uuid,p_other_version integer,p_fx_rate_id uuid,p_fees jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.transactions%rowtype; b public.transactions%rowtype; rate public.fx_rates%rowtype; prior public.transaction_links%rowtype; fee jsonb; normalized jsonb:='[]'; fee_id uuid; fee_amount bigint; fee_category uuid; principal_a numeric; principal_b numeric; equivalent numeric; refunded numeric; evidence jsonb; input jsonb; before_rows jsonb; after_rows jsonb; link uuid:=gen_random_uuid(); changes public.transactions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_operation is null or p_operation not in ('transfer','refund') or p_primary_id is null or p_other_id is null or p_primary_id=p_other_id or p_request_id is null
    or p_expected_version is null or p_expected_version<0 or p_other_version is null or p_other_version<0 or p_fees is null or jsonb_typeof(p_fees)<>'array' or jsonb_array_length(p_fees)>2
    then raise exception 'Invalid verified link input' using errcode='22023'; end if;
  -- All canonical locks in ID order, including readonly refund original, serialize caps and competing pair changes.
  perform 1 from public.transactions where id in(p_primary_id,p_other_id) and public.owns_workspace(workspace_id) order by id for update;
  select * into a from public.transactions where id=p_primary_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Transaction not found' using errcode='P0002'; end if;
  select * into b from public.transactions where id=p_other_id and workspace_id=a.workspace_id;
  if not found then raise exception 'Counterpart not found' using errcode='P0002'; end if;
  for fee in select value from jsonb_array_elements(p_fees) loop
    if jsonb_typeof(fee)<>'object' or fee-array['transaction_id','fee_minor','treatment','category_id','note']<>'{}' or jsonb_typeof(fee->'fee_minor') is distinct from 'string' or fee->>'fee_minor' !~ '^[0-9]{1,19}$'
      or jsonb_typeof(fee->'note') is distinct from 'string' or length(btrim(fee->>'note')) not between 1 and 500 or fee->>'treatment' is null or fee->>'treatment' not in ('included','additional')
      then raise exception 'Explicit fee money, treatment and evidence required' using errcode='22023'; end if;
    begin fee_id:=(fee->>'transaction_id')::uuid; fee_amount:=(fee->>'fee_minor')::bigint; fee_category:=(fee->>'category_id')::uuid;
    exception when numeric_value_out_of_range or invalid_text_representation then raise exception 'Invalid exact fee fields' using errcode='22023'; end;
    if p_operation<>'transfer' or fee_id is null or fee_id not in(a.id,b.id) or fee_amount<=0 or exists(select 1 from jsonb_array_elements(normalized) n where n->>'transaction_id'=fee_id::text) then raise exception 'Invalid fee source' using errcode='22023'; end if;
    if fee_category is not null and not exists(select 1 from public.categories where id=fee_category and workspace_id=a.workspace_id) then raise exception 'Fee category not found' using errcode='P0002'; end if;
    normalized:=normalized||jsonb_build_array(jsonb_build_object('transaction_id',fee_id,'fee_minor',fee_amount::text,'treatment',fee->>'treatment','category_id',fee_category,'note',btrim(fee->>'note')));
  end loop;
  select coalesce(jsonb_agg(value order by value->>'transaction_id'),'[]') into normalized from jsonb_array_elements(normalized);
  input:=jsonb_build_object('operation',p_operation,'primary',a.id,'other',b.id,'primary_version',p_expected_version,'other_version',p_other_version,'fx_rate_id',p_fx_rate_id,'fees',normalized);
  select * into prior from public.transaction_links where workspace_id=a.workspace_id and request_id=p_request_id;
  if found then
    if prior.input<>input then raise exception 'Request reused for another link' using errcode='22023'; end if;
    return jsonb_build_object('linkId',prior.id,'undone',prior.undone_at is not null);
  end if;
  if a.version<>p_expected_version or b.version<>p_other_version then raise exception 'Posting changed; refresh both rows' using errcode='40001'; end if;
  if a.status<>'posted' or b.status<>'posted' or a.transfer_id is not null or a.refund_of_id is not null or b.transfer_id is not null or b.refund_of_id is not null
    or a.kind not in ('ordinary','refund') or b.kind<>'ordinary' or exists(select 1 from public.transaction_split_sets where transaction_id in(a.id,b.id) and undone_at is null)
    then raise exception 'Only posted unlinked sources can be linked; undo splits first' using errcode='22023'; end if;
  if p_fx_rate_id is not null then
    select * into rate from public.fx_rates where id=p_fx_rate_id and workspace_id=a.workspace_id and rate_date<=(case when p_operation='refund' then a.posted_on else greatest(a.posted_on,b.posted_on) end);
    if not found then raise exception 'Owned dated FX evidence not found' using errcode='P0002'; end if;
    evidence:=to_jsonb(rate);
  end if;
  before_rows:=jsonb_build_array(public.link_money_snapshot(a));
  if p_operation='transfer' then
    if a.kind<>'ordinary' or a.account_id=b.account_id or sign(a.amount_minor)=sign(b.amount_minor) or a.amount_minor=0 or b.amount_minor=0
      or exists(select 1 from public.transactions where refund_of_id in(a.id,b.id) or transfer_id in(a.id,b.id)) then raise exception 'Opposite unlinked account postings required' using errcode='22023'; end if;
    principal_a:=abs(a.amount_minor::numeric); principal_b:=abs(b.amount_minor::numeric);
    for fee in select value from jsonb_array_elements(normalized) loop
      if fee->>'treatment'='included' then
        if fee->>'transaction_id'=a.id::text then principal_a:=principal_a+sign(a.amount_minor)*(fee->>'fee_minor')::numeric;
        else principal_b:=principal_b+sign(b.amount_minor)*(fee->>'fee_minor')::numeric; end if;
      end if;
    end loop;
    if principal_a<=0 or principal_b<=0 or public.link_fx_minor(principal_a,a.currency_code,b.currency_code,rate)<>principal_b then raise exception 'Transfer principals do not match exact dated evidence' using errcode='22023'; end if;
    -- Exact known source fees cannot vanish inside a transfer classification. Legacy or unknown
    -- source treatment remains an unresolved review flag until explicitly documented.
    if exists(select 1 from public.transaction_sources ts join public.source_transactions st on st.id=ts.source_transaction_id
      where ts.transaction_id in(a.id,b.id) and st.fee_evidence->>'feeMinor' ~ '^-?[0-9]{1,19}$' and abs((st.fee_evidence->>'feeMinor')::numeric)>0
      and not exists(select 1 from jsonb_array_elements(normalized) f where f->>'transaction_id'=ts.transaction_id::text
        and (f->>'fee_minor')::numeric=abs((st.fee_evidence->>'feeMinor')::numeric)
        and (st.fee_evidence->>'treatment'='unknown' or f->>'treatment'=st.fee_evidence->>'treatment')))
      then raise exception 'Document and preserve each known source fee before linking' using errcode='22023'; end if;
    before_rows:=before_rows||jsonb_build_array(public.link_money_snapshot(b));
  else
    if a.amount_minor<=0 or b.amount_minor>=0 or b.posted_on>a.posted_on or cardinality(b.review_reasons)>0 then raise exception 'Refund needs a preceding reviewed expense; review the original classification first' using errcode='22023'; end if;
    equivalent:=public.link_fx_minor(a.amount_minor,a.currency_code,b.currency_code,rate);
    if equivalent<=0 or equivalent>9223372036854775807 then raise exception 'Refund comparison exceeds supported money' using errcode='22023'; end if;
    select coalesce(sum(case when l.id is not null then l.original_equivalent_minor::numeric else t.amount_minor::numeric end),0) into refunded
      from public.transactions t left join public.transaction_links l on l.primary_transaction_id=t.id and l.operation='refund' and l.undone_at is null where t.refund_of_id=b.id;
    if refunded+equivalent>abs(b.amount_minor::numeric) then raise exception 'Combined refunds exceed the original expense' using errcode='22023'; end if;
  end if;
  perform set_config('moneo.link_edit','on',true);
  if p_operation='transfer' then
    update public.transactions t set kind='transfer',transfer_id=case when id=a.id then b.id else a.id end,
      review_reasons=array(select reason from unnest(t.review_reasons) reason where reason not in ('source_transfer','source_exchange')
        and (reason<>'fee_semantics' or not exists(select 1 from jsonb_array_elements(normalized) f where f->>'transaction_id'=t.id::text))),version=version+1 where id in(a.id,b.id);
  else update public.transactions t set kind='refund',refund_of_id=b.id,review_reasons=array(select reason from unnest(t.review_reasons) reason where reason<>'refund_sign'),version=version+1 where id=a.id; end if;
  select jsonb_agg(public.link_money_snapshot(t) order by t.id) into after_rows from public.transactions t where t.id=a.id or (p_operation='transfer' and t.id=b.id);
  insert into public.transaction_links(id,workspace_id,primary_transaction_id,counterpart_transaction_id,operation,request_id,input,before_rows,after_rows,fx_evidence,original_equivalent_minor,actor_id)
    values(link,a.workspace_id,a.id,b.id,p_operation,p_request_id,input,before_rows,after_rows,evidence,equivalent::bigint,auth.uid());
  for fee in select value from jsonb_array_elements(normalized) loop
    insert into public.transaction_link_fees(workspace_id,link_id,transaction_id,fee_minor,treatment,category_id,note) values(a.workspace_id,link,(fee->>'transaction_id')::uuid,(fee->>'fee_minor')::bigint,fee->>'treatment',(fee->>'category_id')::uuid,fee->>'note');
  end loop;
  for changes in select * from public.transactions where id=a.id or (p_operation='transfer' and id=b.id) loop
    insert into public.correction_events(workspace_id,transaction_id,actor_id,before,after) values(a.workspace_id,changes.id,auth.uid(),
      case when changes.id=a.id then public.link_money_snapshot(a) else public.link_money_snapshot(b) end,public.link_money_snapshot(changes)||jsonb_build_object('operation','verified_link','link_id',link));
  end loop;
  perform set_config('moneo.link_edit','off',true);
  return jsonb_build_object('linkId',link,'undone',false);
end;
$$;

create function public.undo_transaction_link(p_link_id uuid,p_rows jsonb) returns void language plpgsql security definer set search_path='' as $$
declare link public.transaction_links%rowtype; seen jsonb; prior jsonb; row public.transactions%rowtype; current_snapshot jsonb; expected_snapshot jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into link from public.transaction_links where id=p_link_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Link not found' using errcode='P0002'; end if;
  perform 1 from public.transactions where id=link.primary_transaction_id or (link.operation='transfer' and id=link.counterpart_transaction_id) order by id for update;
  select * into link from public.transaction_links where id=p_link_id for update;
  if link.undone_at is not null then return; end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<>jsonb_array_length(link.after_rows) then raise exception 'All modified row versions required' using errcode='22023'; end if;
  for seen in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(seen)<>'object' or seen-array['id','version']<>'{}' or jsonb_typeof(seen->'version') is distinct from 'number' or seen->>'version' !~ '^[0-9]{1,10}$' or jsonb_typeof(seen->'id') is distinct from 'string' then raise exception 'Invalid undo versions' using errcode='22023'; end if;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_rows))<>jsonb_array_length(p_rows) then raise exception 'Duplicate undo row' using errcode='22023'; end if;
  for expected_snapshot in select value from jsonb_array_elements(link.after_rows) loop
    select * into row from public.transactions where id=(expected_snapshot->>'id')::uuid and workspace_id=link.workspace_id;
    select value into seen from jsonb_array_elements(p_rows) where value->>'id'=row.id::text;
    if seen is null or row.version::text<>seen->>'version' then raise exception 'Posting changed; refresh before undo' using errcode='40001'; end if;
    current_snapshot:=public.link_money_snapshot(row)-'version';
    expected_snapshot:=public.link_money_snapshot(jsonb_populate_record(null::public.transactions,expected_snapshot))-'version';
    if current_snapshot<>expected_snapshot then raise exception 'Undo later edits first' using errcode='40001'; end if;
  end loop;
  update public.transaction_links set undone_at=now(),undone_by=auth.uid() where id=link.id;
  perform set_config('moneo.link_edit','on',true);
  for prior in select value from jsonb_array_elements(link.before_rows) loop
    update public.transactions set kind=prior->>'kind',transfer_id=(prior->>'transfer_id')::uuid,refund_of_id=(prior->>'refund_of_id')::uuid,review_reasons=array(select jsonb_array_elements_text(prior->'review_reasons')),version=version+1 where id=(prior->>'id')::uuid;
  end loop;
  update public.correction_events set undone=true where after->>'link_id'=link.id::text;
  perform set_config('moneo.link_edit','off',true);
end;
$$;

create or replace view public.effective_transactions with (security_invoker=true) as
select p.id,p.id as parent_transaction_id,p.workspace_id,p.account_id,p.posted_on,p.posted_at,p.description,p.amount_minor,p.currency_code,p.status,p.kind,p.category_id,p.merchant_id,p.note,p.transfer_id,p.refund_of_id,p.version,p.created_at,p.tags,p.event_name,p.review_reasons
from public.transactions p where not exists(select 1 from public.transaction_split_sets sets where sets.transaction_id=p.id and sets.undone_at is null)
union all
select s.id,p.id as parent_transaction_id,p.workspace_id,p.account_id,p.posted_on,p.posted_at,p.description,s.amount_minor,p.currency_code,p.status,p.kind,s.category_id,p.merchant_id,s.note,p.transfer_id,p.refund_of_id,p.version,p.created_at,p.tags,p.event_name,p.review_reasons
from public.transactions p join public.transaction_splits s on s.parent_transaction_id=p.id and s.workspace_id=p.workspace_id join public.transaction_split_sets sets on sets.id=s.split_set_id and sets.transaction_id=p.id and sets.workspace_id=p.workspace_id and sets.undone_at is null
union all
select f.id,p.id as parent_transaction_id,p.workspace_id,p.account_id,p.posted_on,p.posted_at,p.description,-f.fee_minor,p.currency_code,p.status,'ordinary'::text,f.category_id,p.merchant_id,f.note,null::uuid,null::uuid,p.version,p.created_at,p.tags,p.event_name,p.review_reasons
from public.transaction_link_fees f join public.transaction_links l on l.id=f.link_id and l.workspace_id=f.workspace_id and l.undone_at is null join public.transactions p on p.id=f.transaction_id and p.workspace_id=f.workspace_id;
revoke all on function public.link_money_snapshot(public.transactions),public.link_fx_minor(numeric,text,text,public.fx_rates),public.guard_verified_transaction_link(),public.link_transactions(text,uuid,integer,uuid,integer,uuid,jsonb,uuid),public.undo_transaction_link(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.link_transactions(text,uuid,integer,uuid,integer,uuid,jsonb,uuid),public.undo_transaction_link(uuid,jsonb) to authenticated;

-- Reclassification changes inference evidence, never the immutable original rows or intentional user overrides.
alter table public.recurring_series add column evidence_invalidated boolean not null default false;
alter table public.recurring_series add column evidence_baseline jsonb;
alter table public.recurring_series add column assumption_restore jsonb;
alter table public.recurring_series add column invalidated_assumption_version integer;
create function public.recurring_evidence_snapshot(p public.transactions) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p.id,'account_id',p.account_id,'posted_on',p.posted_on,'description',p.description,'amount_minor',p.amount_minor::text,'currency_code',p.currency_code,'status',p.status,'kind',p.kind,'review_reasons',p.review_reasons)
$$;
create function public.propagate_recurring_evidence() returns trigger language plpgsql security definer set search_path='' as $$
declare series public.recurring_series%rowtype; assumption public.financial_assumptions%rowtype; baseline jsonb; current_evidence jsonb; new_version integer;
begin
  if public.recurring_evidence_snapshot(old)=public.recurring_evidence_snapshot(new) then return new; end if;
  for series in select s.* from public.recurring_series s where s.workspace_id=new.workspace_id and s.status='confirmed'
    and exists(select 1 from public.recurring_series_transactions e where e.series_id=s.id and e.transaction_id=new.id) order by s.id for update loop
    select * into assumption from public.financial_assumptions where id=series.assumption_id and workspace_id=series.workspace_id for update;
    if not series.evidence_invalidated then
      select jsonb_agg(case when t.id=old.id then public.recurring_evidence_snapshot(old) else public.recurring_evidence_snapshot(t) end order by t.id) into baseline
        from public.recurring_series_transactions e join public.transactions t on t.id=e.transaction_id and t.workspace_id=e.workspace_id where e.series_id=series.id;
      update public.recurring_series set evidence_invalidated=true,evidence_baseline=baseline,
        assumption_restore=case when assumption.source='recurring_confirmed' then jsonb_build_object('enabled',assumption.enabled,'confirmed',assumption.confirmed) else null end where id=series.id;
      if assumption.source='recurring_confirmed' and (assumption.enabled or assumption.confirmed) then
        update public.financial_assumptions set enabled=false,confirmed=false where id=assumption.id returning version into new_version;
        update public.recurring_series set invalidated_assumption_version=new_version where id=series.id;
      end if;
    else
      select jsonb_agg(public.recurring_evidence_snapshot(t) order by t.id) into current_evidence from public.recurring_series_transactions e join public.transactions t on t.id=e.transaction_id and t.workspace_id=e.workspace_id where e.series_id=series.id;
      if current_evidence=series.evidence_baseline then
        update public.recurring_series set evidence_invalidated=false,evidence_baseline=null,assumption_restore=null,invalidated_assumption_version=null where id=series.id;
        if assumption.source='recurring_confirmed' and assumption.version=series.invalidated_assumption_version and series.assumption_restore is not null then
          update public.financial_assumptions set enabled=(series.assumption_restore->>'enabled')::boolean,confirmed=(series.assumption_restore->>'confirmed')::boolean where id=assumption.id;
        end if;
      end if;
    end if;
  end loop;
  return new;
end;
$$;
create trigger transaction_recurring_evidence after update on public.transactions for each row execute function public.propagate_recurring_evidence();
create function public.guard_invalidated_recurring_assumption() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.source='recurring_confirmed' and (new.enabled or new.confirmed) and exists(select 1 from public.recurring_series where assumption_id=new.id and evidence_invalidated) then
    raise exception 'Recurring source evidence changed; review and reconfirm or make an explicit user assumption' using errcode='22023';
  end if;
  return new;
end;
$$;
create trigger assumption_invalidated_evidence before insert or update on public.financial_assumptions for each row execute function public.guard_invalidated_recurring_assumption();
revoke all on function public.recurring_evidence_snapshot(public.transactions),public.propagate_recurring_evidence(),public.guard_invalidated_recurring_assumption() from public,anon,authenticated;

-- Reconfirmation validates new source evidence before clearing the invalidation.
create or replace function public.confirm_recurring_series(
  p_account_id uuid,
  p_label text,
  p_cadence text,
  p_currency_code text,
  p_amount_min_minor bigint,
  p_amount_max_minor bigint,
  p_occurrences integer,
  p_confidence integer,
  p_transaction_ids uuid[]
) returns public.recurring_series
language plpgsql security definer set search_path = '' as $$
declare
  account_row public.accounts%rowtype;
  clean_label text := btrim(p_label);
  normalized text;
  series_row public.recurring_series%rowtype;
  evidence_count integer;
  evidence_min bigint;
  evidence_max bigint;
  latest_amount bigint;
  latest_date date;
  assumption_row public.financial_assumptions%rowtype;
  assumption_kind text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if clean_label is null or length(clean_label) < 1 or length(clean_label) > 200 then
    raise exception 'Invalid series label' using errcode = '22023';
  end if;
  normalized := lower(regexp_replace(clean_label, '\s+', ' ', 'g'));
  if p_cadence not in ('weekly', 'monthly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;
  if p_currency_code is null or p_currency_code !~ '^[A-Z]{3}$' then
    raise exception 'Invalid currency' using errcode = '22023';
  end if;
  if p_amount_min_minor is null or p_amount_max_minor is null or p_amount_min_minor > p_amount_max_minor then
    raise exception 'Invalid amount range' using errcode = '22023';
  end if;
  if p_occurrences is null or p_occurrences < 3 then
    raise exception 'Series needs at least 3 occurrences' using errcode = '22023';
  end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 100 then
    raise exception 'Invalid confidence' using errcode = '22023';
  end if;
  if p_transaction_ids is null or coalesce(array_length(p_transaction_ids, 1), 0) < 3
    or coalesce(array_length(p_transaction_ids, 1), 0) > 1000 then
    raise exception 'Evidence must list 3 to 1000 transactions' using errcode = '22023';
  end if;
  if p_occurrences <> array_length(p_transaction_ids, 1) then
    raise exception 'Occurrences must match evidence count' using errcode = '22023';
  end if;

  select * into account_row from public.accounts
  where id = p_account_id and public.owns_workspace(workspace_id)
  for update;
  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  if account_row.currency_code <> p_currency_code then
    raise exception 'Series currency must match account currency' using errcode = '22023';
  end if;

  select count(*), max(posted_on), min(amount_minor), max(amount_minor)
  into evidence_count, latest_date, evidence_min, evidence_max
  from public.transactions
  where id = any (p_transaction_ids)
    and workspace_id = account_row.workspace_id
    and account_id = p_account_id
    and status = 'posted'
    and kind = 'ordinary'
    and cardinality(review_reasons)=0
    and currency_code = p_currency_code;
  if evidence_count <> array_length(p_transaction_ids, 1) then
    raise exception 'Evidence transactions not found' using errcode = 'P0002';
  end if;
  if evidence_min <> p_amount_min_minor or evidence_max <> p_amount_max_minor then
    raise exception 'Evidence amount range changed' using errcode = '22023';
  end if;

  select amount_minor into latest_amount from public.transactions
  where id = any (p_transaction_ids)
    and workspace_id = account_row.workspace_id
    and account_id = p_account_id
  order by posted_on desc, id desc limit 1;

  insert into public.recurring_series
    (workspace_id, account_id, label, normalized_label, cadence, currency_code,
     amount_min_minor, amount_max_minor, occurrences, confidence, status)
  values
    (account_row.workspace_id, p_account_id, clean_label, normalized, p_cadence, p_currency_code,
     p_amount_min_minor, p_amount_max_minor, p_occurrences, p_confidence, 'confirmed')
  on conflict (workspace_id, account_id, normalized_label, cadence, currency_code)
  do update set label = excluded.label,
    amount_min_minor = excluded.amount_min_minor,
    amount_max_minor = excluded.amount_max_minor,
    occurrences = excluded.occurrences,
    confidence = excluded.confidence,
    status = 'confirmed', evidence_invalidated=false, evidence_baseline=null, assumption_restore=null, invalidated_assumption_version=null
  returning * into series_row;

  if series_row.assumption_id is not null then
    select * into assumption_row from public.financial_assumptions
    where id = series_row.assumption_id and workspace_id = account_row.workspace_id
    for update;
  end if;
  assumption_kind := case when latest_amount >= 0 then 'income' else 'expense' end;
  if assumption_row.id is not null and assumption_row.source = 'user' then
    -- User-confirmed edit, disable, or re-enable in Plan wins over this
    -- inferred retry. Keep the user's amount, cadence, dates, and enabled
    -- flag; only series evidence above is refreshed.
    null;
  elsif assumption_row.id is not null then
    update public.financial_assumptions set
      account_id = p_account_id, kind = assumption_kind, name = clean_label,
      amount_minor = latest_amount, currency_code = p_currency_code,
      cadence = p_cadence, starts_on = latest_date,
      source = 'recurring_confirmed', confidence = p_confidence,
      confirmed = true, enabled = true
    where id = assumption_row.id
    returning * into assumption_row;
  else
    insert into public.financial_assumptions
      (workspace_id, account_id, kind, name, amount_minor, currency_code,
       cadence, starts_on, source, confidence, confirmed, enabled)
    values
      (account_row.workspace_id, p_account_id, assumption_kind, clean_label, latest_amount, p_currency_code,
       p_cadence, latest_date, 'recurring_confirmed', p_confidence, true, true)
    returning * into assumption_row;
    update public.recurring_series set assumption_id = assumption_row.id
    where id = series_row.id;
    series_row.assumption_id := assumption_row.id;
  end if;

  delete from public.recurring_series_transactions
  where series_id = series_row.id and workspace_id = account_row.workspace_id;
  insert into public.recurring_series_transactions (series_id, transaction_id, workspace_id)
  select series_row.id, t.id, account_row.workspace_id
  from unnest(p_transaction_ids) as t(id)
  on conflict (series_id, transaction_id) do nothing;

  select * into series_row from public.recurring_series where id = series_row.id;
  return series_row;
end;
$$;

revoke all on function public.confirm_recurring_series(uuid, text, text, text, bigint, bigint, integer, integer, uuid[]) from public;
grant execute on function public.confirm_recurring_series(uuid, text, text, text, bigint, bigint, integer, integer, uuid[]) to authenticated;
