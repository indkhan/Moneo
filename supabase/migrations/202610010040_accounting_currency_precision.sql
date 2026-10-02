-- ISO 4217 accounting precision; no existing money records are rescaled.
create function public.currency_minor_digits(code text) returns integer language sql immutable set search_path='' as $$
  select (('{"AFN":2,"EUR":2,"ALL":2,"DZD":2,"USD":2,"AOA":2,"XCD":2,"XAD":2,"ARS":2,"AMD":2,"AWG":2,"AUD":2,"AZN":2,"BSD":2,"BHD":3,"BDT":2,"BBD":2,"BYN":2,"BZD":2,"XOF":0,"BMD":2,"INR":2,"BTN":2,"BOB":2,"BOV":2,"BAM":2,"BWP":2,"NOK":2,"BRL":2,"BND":2,"BIF":0,"CVE":2,"KHR":2,"XAF":0,"CAD":2,"KYD":2,"CLP":0,"CLF":4,"CNY":2,"COP":2,"COU":2,"KMF":0,"CDF":2,"NZD":2,"CRC":2,"CUP":2,"XCG":2,"CZK":2,"DKK":2,"DJF":0,"DOP":2,"EGP":2,"SVC":2,"ERN":2,"SZL":2,"ETB":2,"FKP":2,"FJD":2,"XPF":0,"GMD":2,"GEL":2,"GHS":2,"GIP":2,"GTQ":2,"GBP":2,"GNF":0,"GYD":2,"HTG":2,"HNL":2,"HKD":2,"HUF":2,"ISK":0,"IDR":2,"IRR":2,"IQD":3,"ILS":2,"JMD":2,"JPY":0,"JOD":3,"KZT":2,"KES":2,"KPW":2,"KRW":0,"KWD":3,"KGS":2,"LAK":2,"LBP":2,"LSL":2,"ZAR":2,"LRD":2,"LYD":3,"CHF":2,"MOP":2,"MKD":2,"MGA":2,"MWK":2,"MYR":2,"MVR":2,"MRU":2,"MUR":2,"MXN":2,"MXV":2,"MDL":2,"MNT":2,"MAD":2,"MZN":2,"MMK":2,"NAD":2,"NPR":2,"NIO":2,"NGN":2,"OMR":3,"PKR":2,"PAB":2,"PGK":2,"PYG":0,"PEN":2,"PHP":2,"PLN":2,"QAR":2,"RON":2,"RUB":2,"RWF":0,"SHP":2,"WST":2,"STN":2,"SAR":2,"RSD":2,"SCR":2,"SLE":2,"SGD":2,"SBD":2,"SOS":2,"SSP":2,"LKR":2,"SDG":2,"SRD":2,"SEK":2,"CHE":2,"CHW":2,"SYP":2,"TWD":2,"TJS":2,"TZS":2,"THB":2,"TOP":2,"TTD":2,"TND":3,"TRY":2,"TMT":2,"UGX":0,"UAH":2,"AED":2,"USN":2,"UYU":2,"UYI":0,"UYW":4,"UZS":2,"VUV":0,"VES":2,"VED":2,"VND":0,"YER":2,"ZMW":2,"ZWG":2,"ANG":2,"BGN":2,"CUC":2,"HRK":2,"SLL":2,"ZWL":2}'::jsonb)->>code)::integer
$$;
revoke all on function public.currency_minor_digits(text) from public,anon,authenticated;

create or replace function public.edit_wealth_item(p_id uuid,p_expected_version integer,p_record jsonb,p_remove boolean,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.wealth_items%rowtype; item public.wealth_items%rowtype; receipt public.wealth_events%rowtype; workspace uuid; snapshot jsonb; event_id uuid:=gen_random_uuid(); digits integer; valuation numeric; existing boolean; money_key text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_id is null or p_request_id is null or p_remove is null or p_record is null or jsonb_typeof(p_record)<>'object' or p_expected_version is null or p_expected_version<0 or p_expected_version>=2147483647 then raise exception 'Invalid wealth edit' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wealth:'||p_id::text,0));
  select * into previous from public.wealth_items where id=p_id and public.owns_workspace(workspace_id) for update;
  existing:=found;
  if not existing and exists(select 1 from public.wealth_items where id=p_id) then raise exception 'Wealth item not found' using errcode='P0002'; end if;
  if existing then workspace:=previous.workspace_id;
  else select id into workspace from public.workspaces where owner_id=auth.uid(); end if;
  if workspace is null or (p_remove and not existing) then raise exception 'Wealth item not found' using errcode='P0002'; end if;
  if p_record-array['kind','name','currency_code','amount_minor','quantity_text','unit_price_text','cost_basis_minor','as_of','linked_account_id','payment_account_id','annual_rate_text','monthly_payment_minor','next_payment_on','payment_assumption_id','payment_transaction_id']<>'{}'::jsonb
    then raise exception 'Unsupported wealth fields' using errcode='22023'; end if;
  if not p_remove then
    foreach money_key in array array['amount_minor','cost_basis_minor','monthly_payment_minor'] loop
      if p_record ? money_key and jsonb_typeof(p_record->money_key)<>'null' and
        (jsonb_typeof(p_record->money_key)<>'string' or p_record->>money_key !~ '^-?[0-9]{1,19}$') then raise exception 'Money must be exact integer text' using errcode='22023'; end if;
    end loop;
    if p_record->>'kind' not in ('holding','asset','debt') or jsonb_typeof(p_record->'name') is distinct from 'string' or char_length(btrim(p_record->>'name')) not between 1 and 120
      or p_record->>'currency_code' !~ '^[A-Z]{3}$' or jsonb_typeof(p_record->'amount_minor') is distinct from 'string' or p_record->>'amount_minor' !~ '^-?[0-9]{1,19}$'
      or p_record->>'as_of' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid wealth evidence' using errcode='22023'; end if;
    begin
      item:=jsonb_populate_record(null::public.wealth_items,p_record||jsonb_build_object('id',p_id,'workspace_id',workspace,'version',coalesce(previous.version,0)+1,'created_at',coalesce(previous.created_at,now()),'updated_at',now(),'removed_at',null));
    exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then raise exception 'Invalid exact wealth values' using errcode='22023'; end;
    item.name:=btrim(item.name);
    digits:=public.currency_minor_digits(item.currency_code);
    if digits is null then raise exception 'Unsupported currency' using errcode='22023'; end if;
    if item.as_of is null or item.as_of>(now() at time zone coalesce((select timezone from public.workspace_settings where workspace_id=workspace),'Europe/Berlin'))::date then raise exception 'Valuation date cannot be in the future' using errcode='22023'; end if;
    if existing and (item.kind<>previous.kind or item.currency_code<>previous.currency_code) then raise exception 'Create a separate record to change kind or currency' using errcode='22023'; end if;
    if item.linked_account_id is not null and not exists(select 1 from public.accounts where id=item.linked_account_id and workspace_id=workspace and currency_code=item.currency_code) then raise exception 'Linked account not found in this currency' using errcode='P0002'; end if;
    if item.cost_basis_minor<0 then raise exception 'Cost basis cannot be negative' using errcode='22023'; end if;
    if item.kind='holding' then
      if item.quantity_text is null or item.unit_price_text is null or item.quantity_text !~ '^[0-9]{1,24}(\.[0-9]{1,18})?$' or item.unit_price_text !~ '^[0-9]{1,24}(\.[0-9]{1,18})?$' or item.quantity_text::numeric<=0 then raise exception 'Invalid exact holding quantity or price' using errcode='22023'; end if;

      valuation:=round(item.quantity_text::numeric*item.unit_price_text::numeric*power(10::numeric,digits));
      if valuation<>item.amount_minor then raise exception 'Holding value must match exact quantity and price' using errcode='22023'; end if;
    elsif item.quantity_text is not null or item.unit_price_text is not null then raise exception 'Only holdings have quantity and price' using errcode='22023'; end if;
    if item.kind='debt' then
      if item.amount_minor>0 or item.cost_basis_minor is not null or item.annual_rate_text is null or item.annual_rate_text !~ '^[0-9]{1,24}(\.[0-9]{1,18})?$' or item.annual_rate_text::numeric>1000 or item.monthly_payment_minor is null or item.monthly_payment_minor<0
        or (item.monthly_payment_minor>0 and (item.next_payment_on is null or item.next_payment_on<item.as_of)) then raise exception 'Invalid debt principal or repayment assumptions' using errcode='22023'; end if;
      if item.payment_account_id is not null and not exists(select 1 from public.accounts where id=item.payment_account_id and workspace_id=workspace and currency_code=item.currency_code and type in ('checking','savings','cash','wallet')) then raise exception 'Liquid payment account not found in this currency' using errcode='P0002'; end if;
      if item.payment_assumption_id is not null and not exists(select 1 from public.financial_assumptions where id=item.payment_assumption_id and workspace_id=workspace and account_id=item.payment_account_id and currency_code=item.currency_code and amount_minor=-item.monthly_payment_minor and cadence='monthly' and starts_on=item.next_payment_on and confirmed and enabled and removed_at is null) then raise exception 'Repayment assumption must match this schedule' using errcode='22023'; end if;
      if item.payment_transaction_id is not null and not exists(select 1 from public.transactions where id=item.payment_transaction_id and workspace_id=workspace and account_id=item.payment_account_id and currency_code=item.currency_code and amount_minor=-item.monthly_payment_minor and status='pending' and posted_on=item.next_payment_on) then raise exception 'Pending repayment must match this schedule' using errcode='22023'; end if;
    elsif item.amount_minor<0 or item.payment_account_id is not null or item.annual_rate_text is not null or item.monthly_payment_minor is not null or item.next_payment_on is not null or item.payment_assumption_id is not null or item.payment_transaction_id is not null then raise exception 'Only debts have repayment assumptions' using errcode='22023'; end if;
  else item:=previous; item.removed_at:=now(); item.version:=previous.version+1; item.updated_at:=now(); end if;
  select * into receipt from public.wealth_events where workspace_id=workspace and request_id=p_request_id;
  if found then
    if receipt.item_id<>p_id or (not p_remove and receipt.after-array['version','created_at','updated_at','removed_at'] is distinct from public.wealth_record(item)-array['version','created_at','updated_at','removed_at']) or (p_remove and receipt.after->>'removed_at' is null)
      then raise exception 'Request ID reused for another wealth edit' using errcode='22023'; end if;
    return jsonb_build_object('eventId',receipt.id,'itemId',p_id);
  end if;
  if (existing and previous.version is distinct from p_expected_version) or (not existing and p_expected_version is distinct from 0) then raise exception 'Wealth item changed; refresh before editing' using errcode='40001'; end if;
  if existing then snapshot:=public.wealth_record(previous); end if;
  insert into public.wealth_items select item.* on conflict(id) do update set name=excluded.name,amount_minor=excluded.amount_minor,quantity_text=excluded.quantity_text,unit_price_text=excluded.unit_price_text,cost_basis_minor=excluded.cost_basis_minor,as_of=excluded.as_of,linked_account_id=excluded.linked_account_id,payment_account_id=excluded.payment_account_id,annual_rate_text=excluded.annual_rate_text,monthly_payment_minor=excluded.monthly_payment_minor,next_payment_on=excluded.next_payment_on,payment_assumption_id=excluded.payment_assumption_id,payment_transaction_id=excluded.payment_transaction_id,version=excluded.version,removed_at=excluded.removed_at,updated_at=excluded.updated_at;
  insert into public.wealth_events(id,workspace_id,item_id,actor_id,request_id,before,after) values(event_id,workspace,p_id,auth.uid(),p_request_id,snapshot,public.wealth_record(item));
  return jsonb_build_object('eventId',event_id,'itemId',p_id);
end;
$$;

