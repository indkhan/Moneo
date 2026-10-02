create table public.forecast_preferences (
  workspace_id uuid primary key references public.workspaces(id),
  currency_code text not null check(currency_code ~ '^[A-Z]{3}$'),
  safety_buffer_minor bigint not null default 0 check(safety_buffer_minor>=0),
  daily_spending_minor bigint not null default 0 check(daily_spending_minor>=0),
  uncertainty_bps integer not null default 1000 check(uncertainty_bps between 0 and 10000),
  spending_account_id uuid references public.accounts(id),
  spending_starts_on date,
  version integer not null default 1 check(version>0),
  updated_at timestamptz not null default now(),
  check(daily_spending_minor=0 or (spending_account_id is not null and spending_starts_on is not null))
);
create table public.forecast_preference_events (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  actor_id uuid not null references auth.users(id), before jsonb, after jsonb not null,
  request_id uuid not null, undo_of uuid references public.forecast_preference_events(id),
  created_at timestamptz not null default now(), undone_at timestamptz,
  unique(workspace_id,request_id)
);
alter table public.forecast_preferences enable row level security;
alter table public.forecast_preference_events enable row level security;
create policy forecast_preferences_owner_select on public.forecast_preferences for select to authenticated using(public.owns_workspace(workspace_id));
create policy forecast_preference_events_owner_select on public.forecast_preference_events for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.forecast_preferences,public.forecast_preference_events from public,anon,authenticated;
grant select on public.forecast_preferences,public.forecast_preference_events to authenticated;
create function public.forecast_preference_record(item public.forecast_preferences) returns jsonb language sql immutable set search_path='' as $$
 select to_jsonb(item)||jsonb_build_object('safety_buffer_minor',item.safety_buffer_minor::text,'daily_spending_minor',item.daily_spending_minor::text)
$$;
revoke all on function public.forecast_preference_record(public.forecast_preferences) from public,anon,authenticated;
create function public.edit_forecast_preferences(p_workspace_id uuid,p_record jsonb,p_expected_version integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.forecast_preferences%rowtype; item public.forecast_preferences%rowtype; receipt public.forecast_preference_events%rowtype; previous_value jsonb; event_id uuid:=gen_random_uuid(); money_key text;
begin
 if auth.uid() is null or not public.owns_workspace(p_workspace_id) then raise exception 'Workspace not found' using errcode='P0002'; end if;
 if p_request_id is null or p_expected_version is null or p_expected_version<0 or p_expected_version>=2147483647 or jsonb_typeof(p_record) is distinct from 'object' then raise exception 'Invalid forecast preferences' using errcode='22023'; end if;
 if p_record-array['currency_code','safety_buffer_minor','daily_spending_minor','uncertainty_bps','spending_account_id','spending_starts_on']<>'{}'::jsonb then raise exception 'Unsupported forecast fields' using errcode='22023'; end if;
 foreach money_key in array array['safety_buffer_minor','daily_spending_minor'] loop
  if jsonb_typeof(p_record->money_key) is distinct from 'string' or p_record->>money_key !~ '^[0-9]{1,19}$' then raise exception 'Exact nonnegative money text required' using errcode='22023'; end if;
 end loop;
 if p_record->>'currency_code' !~ '^[A-Z]{3}$' or jsonb_typeof(p_record->'currency_code') is distinct from 'string' or public.currency_minor_digits(p_record->>'currency_code') is null or jsonb_typeof(p_record->'uncertainty_bps') is distinct from 'number' or p_record->>'uncertainty_bps' !~ '^\d{1,5}$' then raise exception 'Invalid currency or uncertainty' using errcode='22023'; end if;
 if p_record->>'spending_starts_on' is not null and (jsonb_typeof(p_record->'spending_starts_on')<>'string' or p_record->>'spending_starts_on' !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'Use an explicit calendar start date' using errcode='22023'; end if;
 perform id from public.workspaces where id=p_workspace_id for update;
 select * into previous from public.forecast_preferences where workspace_id=p_workspace_id for update;
 previous_value:=case when found then public.forecast_preference_record(previous) end;
 begin
  item:=jsonb_populate_record(null::public.forecast_preferences,p_record||jsonb_build_object('workspace_id',p_workspace_id,'version',coalesce(previous.version,0)+1,'updated_at',now()));
 exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then raise exception 'Invalid preference values' using errcode='22023'; end;
 if item.safety_buffer_minor is null or item.daily_spending_minor is null or item.uncertainty_bps is null or item.uncertainty_bps not between 0 and 10000 then raise exception 'Missing preference values' using errcode='22023'; end if;
 if item.spending_account_id is not null and not exists(select 1 from public.accounts where id=item.spending_account_id and workspace_id=p_workspace_id and type in ('checking','savings','cash','wallet') and coalesce(to_jsonb(accounts)->>'archived_at','')='') then raise exception 'Liquid spending account unavailable' using errcode='22023'; end if;
 select * into receipt from public.forecast_preference_events where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if receipt.after-array['workspace_id','version','updated_at'] is distinct from public.forecast_preference_record(item)-array['workspace_id','version','updated_at'] or coalesce((receipt.before->>'version')::integer,0)<>p_expected_version then raise exception 'Request reused for different preferences' using errcode='22023'; end if;
  return jsonb_build_object('eventId',receipt.id,'version',receipt.after->'version');
 end if;
 if coalesce(previous.version,0)<>p_expected_version then raise exception 'Preferences changed; refresh before editing' using errcode='40001'; end if;
 insert into public.forecast_preferences select item.* on conflict(workspace_id) do update set currency_code=excluded.currency_code,safety_buffer_minor=excluded.safety_buffer_minor,daily_spending_minor=excluded.daily_spending_minor,uncertainty_bps=excluded.uncertainty_bps,spending_account_id=excluded.spending_account_id,spending_starts_on=excluded.spending_starts_on,version=excluded.version,updated_at=excluded.updated_at;
 insert into public.forecast_preference_events(id,workspace_id,actor_id,before,after,request_id) values(event_id,p_workspace_id,auth.uid(),previous_value,public.forecast_preference_record(item),p_request_id);
 return jsonb_build_object('eventId',event_id,'version',item.version);
end $$;
create function public.undo_forecast_preferences(p_event_id uuid,p_expected_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare event public.forecast_preference_events%rowtype; item public.forecast_preferences%rowtype; original jsonb; compensation jsonb; currency text;
begin
 select * into event from public.forecast_preference_events where id=p_event_id and public.owns_workspace(workspace_id);
 if not found or event.undo_of is not null then raise exception 'Preference event unavailable' using errcode='P0002'; end if;
 perform id from public.workspaces where id=event.workspace_id for update;
 select * into event from public.forecast_preference_events where id=p_event_id for update;
 if event.undone_at is not null then return jsonb_build_object('eventId',event.id,'undone',true); end if;
 select * into item from public.forecast_preferences where workspace_id=event.workspace_id for update;
 if p_expected_version is null or item.version<>p_expected_version or public.forecast_preference_record(item)-array['version','updated_at'] is distinct from event.after-array['version','updated_at'] or exists(select 1 from public.forecast_preference_events where workspace_id=event.workspace_id and undo_of is null and undone_at is null and (after->>'version')::integer>(event.after->>'version')::integer) then raise exception 'Preferences changed; undo newer changes first' using errcode='40001'; end if;
 select display_currency into currency from public.workspaces where id=event.workspace_id;
 original:=coalesce(event.before,jsonb_build_object('currency_code',currency,'safety_buffer_minor','0','daily_spending_minor','0','uncertainty_bps',1000,'spending_account_id',null,'spending_starts_on',null))-array['workspace_id','version','updated_at'];
 compensation:=public.edit_forecast_preferences(event.workspace_id,original,item.version,gen_random_uuid());
 update public.forecast_preference_events set undo_of=event.id where id=(compensation->>'eventId')::uuid;
 update public.forecast_preference_events set undone_at=now() where id=event.id;
 return jsonb_build_object('eventId',event.id,'undone',true);
end $$;
revoke all on function public.edit_forecast_preferences(uuid,jsonb,integer,uuid),public.undo_forecast_preferences(uuid,integer) from public,anon;
grant execute on function public.edit_forecast_preferences(uuid,jsonb,integer,uuid),public.undo_forecast_preferences(uuid,integer) to authenticated;
