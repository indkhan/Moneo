create function public.workspace_time_zone(p_workspace_id uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare zone text;
begin
  select timezone into zone from public.workspace_settings where workspace_id=p_workspace_id;
  if zone is null then raise exception 'Workspace time zone is not set' using errcode='55000'; end if;
  return zone;
end;
$$;
revoke all on function public.workspace_time_zone(uuid) from public,anon,authenticated;

alter table public.workspace_settings alter column timezone drop default;

alter table public.spending_plans alter column rollover_from drop default;
create function public.set_spending_plan_rollover_from() returns trigger language plpgsql security definer set search_path='' as $$
begin
  new.rollover_from:=date_trunc('month',now() at time zone public.workspace_time_zone(new.workspace_id))::date;
  return new;
end;
$$;
revoke all on function public.set_spending_plan_rollover_from() from public,anon,authenticated;
create trigger spending_plan_rollover_from before insert on public.spending_plans for each row when (new.rollover_from is null) execute function public.set_spending_plan_rollover_from();

do $$
declare fn oid; patched text;
begin
  for fn in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc like '%''Europe/Berlin''%'
  loop
    patched := pg_get_functiondef(fn);
    patched := regexp_replace(patched, 'coalesce\(\(select (?:s\.)?timezone from \w+\.workspace_settings (?:s )?where workspace_id ?= ?([\w.]+)\), ?''Europe/Berlin''\)', 'public.workspace_time_zone(\1)', 'g');
    patched := regexp_replace(patched, 'select timezone into zone from \w+\.workspace_settings where workspace_id = connection\.workspace_id;\s+zone := coalesce\(zone, ''Europe/Berlin''\);', 'zone := public.workspace_time_zone(connection.workspace_id);');
    patched := regexp_replace(patched, 'select timezone into zone from \w+\.workspace_settings where workspace_id=row\.workspace_id;(\s+)item\.removed_at:=\(row\.posted_on::timestamp\) at time zone coalesce\(zone,''Europe/Berlin''\);', 'zone:=public.workspace_time_zone(row.workspace_id);\1item.removed_at:=(row.posted_on::timestamp) at time zone zone;');
    if patched like '%Europe/Berlin%' then raise exception 'Time zone fallback left in function %', fn::regprocedure; end if;
    execute patched;
  end loop;
end $$;
