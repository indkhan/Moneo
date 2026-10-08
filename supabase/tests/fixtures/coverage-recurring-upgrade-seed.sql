-- Seed an outstanding ORIGINAL receipt before 017; private runner targets only.
create table public.qa_recurring_upgrade(actor uuid, assumption_id uuid, event_id uuid, expected_version integer, original_receipt jsonb);
do $$
declare actor uuid:=gen_random_uuid(); w uuid; a uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); e uuid;
begin
 insert into auth.users(id,email) values(actor,'mne014-upgrade-'||actor||'@example.invalid');
 select id into strict w from public.workspaces where owner_id=actor;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 insert into public.accounts(id,workspace_id,name,currency_code) values(a,w,'Upgrade receipt','EUR');
 insert into public.financial_assumptions(id,workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,source,confirmed)
 values(f,w,a,'expense','Original schedule',-1000,'EUR','monthly','2026-01-31','user',true);
 e:=public.edit_assumption(f,1,'{"amount_minor":"-2000"}',gen_random_uuid());
 insert into public.qa_recurring_upgrade select actor,f,e,2,to_jsonb(p) from public.planning_events p where id=e;
end;
$$;
