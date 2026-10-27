-- Background jobs (bank sync, CSV import) link own-account transfers with the service role,
-- which has no user session. These two RPCs accept the service role for a workspace and record
-- the workspace owner as the actor, so correction and link audit rows still name the owner.
-- Signed-in users keep exactly the behaviour they had before.

create function public.can_link_workspace(p_workspace_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.owns_workspace(p_workspace_id)
    or ((select auth.jwt()->>'role') = 'service_role' and exists (select 1 from public.workspaces where id = p_workspace_id));
$$;

create function public.link_actor(p_workspace_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case when (select auth.jwt()->>'role') = 'service_role'
    then (select owner_id from public.workspaces where id = p_workspace_id)
    else (select auth.uid()) end;
$$;

revoke all on function public.can_link_workspace(uuid), public.link_actor(uuid) from public, anon;

grant execute on function public.can_link_workspace(uuid), public.link_actor(uuid) to authenticated, service_role;

create or replace function public.link_transactions(p_operation text,p_primary_id uuid,p_expected_version integer,p_other_id uuid,p_other_version integer,p_fx_rate_id uuid,p_fees jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.transactions%rowtype; b public.transactions%rowtype; rate public.fx_rates%rowtype; prior public.transaction_links%rowtype; fee jsonb; normalized jsonb:='[]'; fee_id uuid; fee_amount bigint; fee_category uuid; principal_a numeric; principal_b numeric; equivalent numeric; refunded numeric; evidence jsonb; input jsonb; before_rows jsonb; after_rows jsonb; link uuid:=gen_random_uuid(); changes public.transactions%rowtype; actor uuid;
begin
  if auth.uid() is null and (select auth.jwt()->>'role') is distinct from 'service_role' then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_operation is null or p_operation not in ('transfer','refund') or p_primary_id is null or p_other_id is null or p_primary_id=p_other_id or p_request_id is null
    or p_expected_version is null or p_expected_version<0 or p_other_version is null or p_other_version<0 or p_fees is null or jsonb_typeof(p_fees)<>'array' or jsonb_array_length(p_fees)>2
    then raise exception 'Invalid verified link input' using errcode='22023'; end if;
  -- All canonical locks in ID order, including readonly refund original, serialize caps and competing pair changes.
  perform 1 from public.transactions where id in(p_primary_id,p_other_id) and public.can_link_workspace(workspace_id) order by id for update;
  select * into a from public.transactions where id=p_primary_id and public.can_link_workspace(workspace_id);
  if not found then raise exception 'Transaction not found' using errcode='P0002'; end if;
  actor:=public.link_actor(a.workspace_id);
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
    values(link,a.workspace_id,a.id,b.id,p_operation,p_request_id,input,before_rows,after_rows,evidence,equivalent::bigint,actor);
  for fee in select value from jsonb_array_elements(normalized) loop
    insert into public.transaction_link_fees(workspace_id,link_id,transaction_id,fee_minor,treatment,category_id,note) values(a.workspace_id,link,(fee->>'transaction_id')::uuid,(fee->>'fee_minor')::bigint,fee->>'treatment',(fee->>'category_id')::uuid,fee->>'note');
  end loop;
  for changes in select * from public.transactions where id=a.id or (p_operation='transfer' and id=b.id) loop
    insert into public.correction_events(workspace_id,transaction_id,actor_id,before,after) values(a.workspace_id,changes.id,actor,
      case when changes.id=a.id then public.link_money_snapshot(a) else public.link_money_snapshot(b) end,public.link_money_snapshot(changes)||jsonb_build_object('operation','verified_link','link_id',link));
  end loop;
  perform set_config('moneo.link_edit','off',true);
  return jsonb_build_object('linkId',link,'undone',false);
end;
$$;

create or replace function public.mark_own_account_transfer(
  p_transaction_id uuid,
  p_expected_version integer,
  p_identifier_id uuid
) returns public.transactions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  old_row public.transactions%rowtype;
  new_row public.transactions%rowtype;
  identifier public.own_account_identifiers%rowtype;
begin
  if auth.uid() is null and (select auth.jwt()->>'role') is distinct from 'service_role' then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into old_row from public.transactions
  where id = p_transaction_id and public.can_link_workspace(workspace_id) for update;
  if not found then raise exception 'Transaction not found' using errcode = 'P0002'; end if;
  actor := public.link_actor(old_row.workspace_id);
  select * into identifier from public.own_account_identifiers
  where id = p_identifier_id and workspace_id = old_row.workspace_id and account_id is null;
  if not found then raise exception 'Own untracked account not found' using errcode = 'P0002'; end if;
  if old_row.version is distinct from p_expected_version then
    raise exception 'Transaction changed; refresh and retry' using errcode = '40001';
  end if;
  if old_row.status <> 'posted' or old_row.kind <> 'ordinary' or old_row.transfer_id is not null or old_row.refund_of_id is not null
    or old_row.amount_minor = 0 or not (old_row.review_reasons <@ array['source_transfer']::text[])
    or exists (select 1 from public.transactions where refund_of_id = old_row.id or transfer_id = old_row.id)
    or exists (select 1 from public.transaction_split_sets where transaction_id = old_row.id and undone_at is null)
    or exists (select 1 from public.transaction_links where undone_at is null and (primary_transaction_id = old_row.id or counterpart_transaction_id = old_row.id))
  then raise exception 'Only posted, unlinked, unsplit transactions can be marked' using errcode = '22023'; end if;

  update public.transactions set kind = 'transfer', review_reasons = '{}', version = version + 1
  where id = old_row.id returning * into new_row;
  insert into public.correction_events (workspace_id, transaction_id, actor_id, before, after)
  values (old_row.workspace_id, old_row.id, actor,
    jsonb_build_object('category_id', old_row.category_id, 'note', old_row.note, 'kind', old_row.kind,
      'transfer_id', old_row.transfer_id, 'refund_of_id', old_row.refund_of_id,
      'review_reasons', to_jsonb(old_row.review_reasons), 'version', old_row.version),
    jsonb_build_object('category_id', new_row.category_id, 'note', new_row.note, 'kind', new_row.kind,
      'transfer_id', new_row.transfer_id, 'refund_of_id', new_row.refund_of_id,
      'review_reasons', to_jsonb(new_row.review_reasons), 'version', new_row.version,
      'operation', 'own_account_transfer', 'identifier_id', identifier.id, 'own_account', identifier.label));
  return new_row;
end;
$$;

grant execute on function public.link_transactions(text,uuid,integer,uuid,integer,uuid,jsonb,uuid) to service_role;

grant execute on function public.mark_own_account_transfer(uuid, integer, uuid) to service_role;
