-- Store which local speech-to-text model the owner chose: a suggested model's id or the folder of their own model.
alter table public.workspace_settings add column speech_local_model text,
  add constraint workspace_settings_speech_local_model_check check (length(speech_local_model) between 1 and 1000);


create or replace function public.save_workspace_preferences(p_workspace_id uuid,p_display_currency text,p_preferences jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare preferences public.workspace_settings%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if not public.owns_workspace(p_workspace_id) then raise exception 'Workspace not found' using errcode='P0002'; end if;
  if p_display_currency is null or p_display_currency !~ '^[A-Z]{3}$' or p_preferences is null or jsonb_typeof(p_preferences)<>'object'
    or not(p_preferences ?& array['timezone','locale','theme','voice','ai_models','ai_data_scopes','muted_insight_types','summary_cadence','summary_time'])
    or p_preferences-array['timezone','locale','theme','voice','ai_models','ai_data_scopes','muted_insight_types','summary_cadence','summary_time','artifact_scalable_data','speech_engine','speech_local_model']<>'{}'::jsonb then
    raise exception 'Invalid workspace preferences' using errcode='22023';
  end if;
  if exists(select 1 from unnest(array['timezone','locale','theme','voice','summary_cadence','summary_time']) key where jsonb_typeof(p_preferences->key) is distinct from 'string')
    or jsonb_typeof(p_preferences->'ai_models') is distinct from 'object'
    or exists(select 1 from jsonb_each(p_preferences->'ai_models') model where model.key not in ('default','chat','review','agents','imports','organize','artifacts','titles','voice_call') or jsonb_typeof(model.value)<>'string' or length(model.value#>>'{}') not between 1 and 200)
    or jsonb_typeof(p_preferences->'ai_data_scopes') is distinct from 'array'
    or jsonb_typeof(p_preferences->'muted_insight_types') is distinct from 'array'
    or coalesce(p_preferences->>'artifact_scalable_data','snapshot') not in ('snapshot','live')
    or coalesce(p_preferences->>'speech_engine','openai') not in ('openai','local','openrouter')
    or coalesce(jsonb_typeof(p_preferences->'speech_local_model'),'null') not in ('string','null')
    or length(p_preferences->>'speech_local_model') not between 1 and 1000 then
    raise exception 'Invalid preference field types' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_preferences->'ai_data_scopes') value where jsonb_typeof(value)<>'string')
    or exists(select 1 from jsonb_array_elements(p_preferences->'muted_insight_types') value where jsonb_typeof(value)<>'string')
    or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_preferences->>'timezone') then
    raise exception 'Invalid timezone or preference list' using errcode='22023';
  end if;
  preferences:=jsonb_populate_record(null::public.workspace_settings,p_preferences);
  update public.workspaces set display_currency=p_display_currency where id=p_workspace_id;
  insert into public.workspace_settings(workspace_id,timezone,locale,theme,voice,ai_models,ai_data_scopes,muted_insight_types,summary_cadence,summary_time,artifact_scalable_data,speech_engine,speech_local_model,updated_at)
    values(p_workspace_id,preferences.timezone,preferences.locale,preferences.theme,preferences.voice,preferences.ai_models,preferences.ai_data_scopes,preferences.muted_insight_types,preferences.summary_cadence,preferences.summary_time,coalesce(preferences.artifact_scalable_data,'snapshot'),coalesce(preferences.speech_engine,'openai'),preferences.speech_local_model,now())
    on conflict(workspace_id) do update set timezone=excluded.timezone,locale=excluded.locale,theme=excluded.theme,voice=excluded.voice,ai_models=excluded.ai_models,
      ai_data_scopes=excluded.ai_data_scopes,muted_insight_types=excluded.muted_insight_types,summary_cadence=excluded.summary_cadence,summary_time=excluded.summary_time,
      artifact_scalable_data=excluded.artifact_scalable_data,speech_engine=excluded.speech_engine,speech_local_model=excluded.speech_local_model,updated_at=excluded.updated_at;
end;
$$;
