-- R1: existing owned edit/history/Undo must preserve or intentionally replace anchors.
do $$
declare actor uuid:=gen_random_uuid(); w uuid; account uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); e1 uuid; e2 uuid; e3 uuid; posting uuid:=gen_random_uuid(); receipt public.recurring_occurrence_settlements%rowtype;
begin
 insert into auth.users(id,email) values(actor,'mne014-r1-anchor-'||actor||'@example.invalid');
 select id into strict w from public.workspaces where owner_id=actor;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 insert into public.accounts(id,workspace_id,name,currency_code) values(account,w,'R1 calendar history','EUR');
 insert into public.financial_assumptions(id,workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,schedule_anchor_on,source,confirmed)
 values(f,w,account,'expense','Quarterly end of month',-9007199254740993,'EUR','quarterly','2026-04-30','2025-10-31','recurring_confirmed',true);
 execute 'set local role authenticated';
 e1:=public.edit_assumption(f,1,'{"enabled":false}',gen_random_uuid());
 e2:=public.edit_assumption(f,2,'{"enabled":true}',gen_random_uuid());
 execute 'reset role';
 if not exists(select 1 from public.financial_assumptions where id=f and source='user' and enabled and schedule_anchor_on='2025-10-31' and amount_minor=-9007199254740993) then raise exception 'Enabled toggle lost original anchor or exact amount'; end if;
 if public.recurring_scheduled_date((select schedule_anchor_on from public.financial_assumptions where id=f),'quarterly',3)<>'2026-07-31' then raise exception 'Enabled toggle drifted calendar'; end if;
 -- Real occurrence validation must honor the same retained anchor after source=user.
 insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind)
 values(posting,w,account,'2026-07-31','R1 observed quarterly payment',-9007199254740993,'EUR','posted','ordinary');
 execute 'set local role authenticated';
 begin
   perform public.record_recurring_occurrence(f,3,'2026-07-30',posting,0,true);
   raise exception 'Toggle allowed drifted occurrence date';
 exception when sqlstate '22023' then null; end;
 receipt:=public.record_recurring_occurrence(f,3,'2026-07-31',posting,0,true);
 receipt:=public.undo_recurring_occurrence(receipt.id,receipt.version);
 if receipt.undone_at is null or receipt.receipt->>'amount_minor'<>'-9007199254740993' then raise exception 'Retained-anchor occurrence Undo lost exact receipt'; end if;
 -- The full edit form sends unchanged date/cadence as well as an amount edit.
 e3:=public.edit_assumption(f,3,'{"amount_minor":"-12345","cadence":"quarterly","starts_on":"2026-04-30"}',gen_random_uuid());
 execute 'reset role';
 if (select schedule_anchor_on from public.financial_assumptions where id=f)<>'2025-10-31' then raise exception 'Unchanged date inputs reset anchor'; end if;
 perform public.undo_planning_event(e3,4);
 perform public.undo_planning_event(e2,5);
 perform public.undo_planning_event(e1,6);
 if not exists(select 1 from public.financial_assumptions where id=f and source='recurring_confirmed' and enabled and schedule_anchor_on='2025-10-31' and amount_minor=-9007199254740993 and version=7) then raise exception 'Toggle Undo lost original schedule/history'; end if;
 execute 'set local role authenticated';
 e3:=public.edit_assumption(f,7,'{"starts_on":"2026-05-15"}',gen_random_uuid());
 execute 'reset role';
 if not exists(select 1 from public.financial_assumptions where id=f and source='user' and starts_on='2026-05-15' and schedule_anchor_on='2026-05-15') then raise exception 'Explicit date edit retained old anchor'; end if;
 if public.recurring_scheduled_date((select schedule_anchor_on from public.financial_assumptions where id=f),'quarterly',1)<>'2026-08-15' then raise exception 'Explicit date does not control forecast'; end if;
 perform public.undo_planning_event(e3,8);
 execute 'set local role authenticated';
 e3:=public.edit_assumption(f,9,'{"cadence":"monthly"}',gen_random_uuid());
 execute 'reset role';
 if not exists(select 1 from public.financial_assumptions where id=f and cadence='monthly' and source='user' and schedule_anchor_on='2026-04-30') then raise exception 'Cadence edit failed intentional start anchor'; end if;
 perform public.undo_planning_event(e3,10);
 if not exists(select 1 from public.financial_assumptions where id=f and cadence='quarterly' and source='recurring_confirmed' and schedule_anchor_on='2025-10-31' and version=11) then raise exception 'Schedule edit Undo lost calendar'; end if;
end;
$$;
