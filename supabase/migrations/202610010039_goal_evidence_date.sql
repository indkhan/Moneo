-- Direct authenticated inserts must enforce the same dated-evidence boundary as edits.
create function public.guard_goal_evidence_date() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.saved_as_of>(now() at time zone coalesce((select timezone from public.workspace_settings where workspace_id=new.workspace_id),'Europe/Berlin'))::date then
    raise exception 'Recorded savings date cannot be in the future' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_goal_evidence_date() from public;
create trigger goal_evidence_date_guard before insert or update on public.goals for each row execute function public.guard_goal_evidence_date();
