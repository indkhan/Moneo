create table public.wealth_items (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id),
  kind text not null check(kind in ('holding','asset','debt')),
  name text not null check(char_length(name) between 1 and 120),
  currency_code text not null check(currency_code ~ '^[A-Z]{3}$'),
  amount_minor bigint not null,
  quantity_text text,
  unit_price_text text,
  cost_basis_minor bigint,
  as_of date not null,
  linked_account_id uuid references public.accounts(id),
  payment_account_id uuid references public.accounts(id),
  annual_rate_text text,
  monthly_payment_minor bigint,
  next_payment_on date,
  payment_assumption_id uuid references public.financial_assumptions(id),
  payment_transaction_id uuid references public.transactions(id),
  version integer not null default 1,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((kind='debt' and amount_minor<=0) or (kind<>'debt' and amount_minor>=0)),
  check(cost_basis_minor is null or cost_basis_minor>=0),
  check(monthly_payment_minor is null or monthly_payment_minor>=0)
);
create table public.wealth_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  item_id uuid not null references public.wealth_items(id),
  actor_id uuid not null references auth.users(id),
  request_id uuid not null,
  before jsonb,
  after jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id),
  unique(workspace_id,request_id)
);
alter table public.wealth_items enable row level security;
alter table public.wealth_events enable row level security;
create policy wealth_items_owner_select on public.wealth_items for select to authenticated using(public.owns_workspace(workspace_id));
create policy wealth_events_owner_select on public.wealth_events for select to authenticated using(public.owns_workspace(workspace_id));
grant select on public.wealth_items,public.wealth_events to authenticated;
revoke insert,update,delete on public.wealth_items,public.wealth_events from public,authenticated;

create function public.wealth_record(item public.wealth_items) returns jsonb language sql immutable set search_path='' as $$
  select to_jsonb(item)||jsonb_build_object('amount_minor',item.amount_minor::text,'cost_basis_minor',item.cost_basis_minor::text,'monthly_payment_minor',item.monthly_payment_minor::text);
$$;
create function public.edit_wealth_item(p_id uuid,p_expected_version integer,p_record jsonb,p_remove boolean,p_request_id uuid)
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
    -- Match the application's supported currency set; never guess precision for an unknown code.
    if not item.currency_code=any(string_to_array('AED,AFN,ALL,AMD,ANG,AOA,ARS,AUD,AWG,AZN,BAM,BBD,BDT,BGN,BHD,BIF,BMD,BND,BOB,BRL,BSD,BTN,BWP,BYN,BZD,CAD,CDF,CHF,CLP,CNY,COP,CRC,CUC,CUP,CVE,CZK,DJF,DKK,DOP,DZD,EGP,ERN,ETB,EUR,FJD,FKP,GBP,GEL,GHS,GIP,GMD,GNF,GTQ,GYD,HKD,HNL,HRK,HTG,HUF,IDR,ILS,INR,IQD,IRR,ISK,JMD,JOD,JPY,KES,KGS,KHR,KMF,KPW,KRW,KWD,KYD,KZT,LAK,LBP,LKR,LRD,LSL,LYD,MAD,MDL,MGA,MKD,MMK,MNT,MOP,MRU,MUR,MVR,MWK,MXN,MYR,MZN,NAD,NGN,NIO,NOK,NPR,NZD,OMR,PAB,PEN,PGK,PHP,PKR,PLN,PYG,QAR,RON,RSD,RUB,RWF,SAR,SBD,SCR,SDG,SEK,SGD,SHP,SLE,SLL,SOS,SRD,SSP,STN,SVC,SYP,SZL,THB,TJS,TMT,TND,TOP,TRY,TTD,TWD,TZS,UAH,UGX,USD,UYU,UZS,VES,VND,VUV,WST,XAF,XCD,XCG,XDR,XOF,XPF,XSU,YER,ZAR,ZMW,ZWG,ZWL',',')) then raise exception 'Unsupported currency' using errcode='22023'; end if;
    if item.as_of is null or item.as_of>(now() at time zone coalesce((select timezone from public.workspace_settings where workspace_id=workspace),'Europe/Berlin'))::date then raise exception 'Valuation date cannot be in the future' using errcode='22023'; end if;
    if existing and (item.kind<>previous.kind or item.currency_code<>previous.currency_code) then raise exception 'Create a separate record to change kind or currency' using errcode='22023'; end if;
    if item.linked_account_id is not null and not exists(select 1 from public.accounts where id=item.linked_account_id and workspace_id=workspace and currency_code=item.currency_code) then raise exception 'Linked account not found in this currency' using errcode='P0002'; end if;
    if item.cost_basis_minor<0 then raise exception 'Cost basis cannot be negative' using errcode='22023'; end if;
    if item.kind='holding' then
      if item.quantity_text is null or item.unit_price_text is null or item.quantity_text !~ '^[0-9]{1,24}(\.[0-9]{1,18})?$' or item.unit_price_text !~ '^[0-9]{1,24}(\.[0-9]{1,18})?$' or item.quantity_text::numeric<=0 then raise exception 'Invalid exact holding quantity or price' using errcode='22023'; end if;
      digits:=case when item.currency_code in ('BHD','JOD','KWD','LYD','OMR','TND') then 3 when item.currency_code in ('AFN','ALL','BIF','CLP','COP','DJF','GNF','HUF','IDR','IQD','IRR','ISK','JPY','KMF','KPW','KRW','LAK','LBP','MGA','MMK','PKR','PYG','RWF','SLL','SOS','SYP','UGX','VND','VUV','XAF','XOF','XPF','YER') then 0 else 2 end;
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

create function public.undo_wealth_event(p_event_id uuid,p_expected_version integer) returns void language plpgsql security definer set search_path='' as $$
declare event public.wealth_events%rowtype; current_item public.wealth_items%rowtype; restored public.wealth_items%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into event from public.wealth_events where id=p_event_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Wealth event not found' using errcode='P0002'; end if;
  select * into current_item from public.wealth_items where id=event.item_id and workspace_id=event.workspace_id for update;
  select * into event from public.wealth_events where id=p_event_id for update;
  if event.undone_at is not null then return; end if;
  if current_item.version is distinct from p_expected_version or public.wealth_record(current_item)-array['version','updated_at'] is distinct from event.after-array['version','updated_at']
    or exists(select 1 from public.wealth_events where item_id=event.item_id and undone_at is null and (after->>'version')::integer>(event.after->>'version')::integer) then raise exception 'Wealth item changed; undo later edits first' using errcode='40001'; end if;
  if event.before is null then restored:=current_item; restored.removed_at:=now();
  else restored:=jsonb_populate_record(null::public.wealth_items,event.before); end if;
  restored.version:=current_item.version+1; restored.updated_at:=now();
  update public.wealth_items set name=restored.name,amount_minor=restored.amount_minor,quantity_text=restored.quantity_text,unit_price_text=restored.unit_price_text,cost_basis_minor=restored.cost_basis_minor,as_of=restored.as_of,linked_account_id=restored.linked_account_id,payment_account_id=restored.payment_account_id,annual_rate_text=restored.annual_rate_text,monthly_payment_minor=restored.monthly_payment_minor,next_payment_on=restored.next_payment_on,payment_assumption_id=restored.payment_assumption_id,payment_transaction_id=restored.payment_transaction_id,version=restored.version,removed_at=restored.removed_at,updated_at=restored.updated_at where id=restored.id;
  update public.wealth_events set undone_at=now(),undone_by=auth.uid() where id=event.id;
end;
$$;
revoke all on function public.wealth_record(public.wealth_items),public.edit_wealth_item(uuid,integer,jsonb,boolean,uuid),public.undo_wealth_event(uuid,integer) from public;
grant execute on function public.edit_wealth_item(uuid,integer,jsonb,boolean,uuid),public.undo_wealth_event(uuid,integer) to authenticated;
