-- R2: provenance-only edits preserve current confirmed source fulfillment.
do $$
declare actor uuid:=gen_random_uuid(); w uuid; account uuid:=gen_random_uuid(); ids uuid[]:=array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; versions jsonb; originals jsonb; series public.recurring_series%rowtype; off_event uuid; on_event uuid; override_event uuid;
begin
 insert into auth.users(id,email) values(actor,'mne014-r2-'||actor||'@example.invalid');
 select id into strict w from public.workspaces where owner_id=actor;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 insert into public.accounts(id,workspace_id,name,currency_code) values(account,w,'Early paid toggle fixture','EUR');
 insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values
 (ids[1],w,account,'2026-01-31','Stable monthly invoice 1',-9007199254740993,'EUR','posted','ordinary'),
 (ids[2],w,account,'2026-02-28','Stable monthly invoice 2',-9007199254740993,'EUR','posted','ordinary'),
 (ids[3],w,account,'2026-03-30','Stable monthly invoice 3',-9007199254740993,'EUR','posted','ordinary');
 select jsonb_agg(jsonb_build_object('id',id,'version',version) order by posted_on,id),jsonb_agg(to_jsonb(t) order by id) into versions,originals from public.transactions t where id=any(ids);
 execute 'set local role authenticated';
 series:=public.review_recurring_series_versions('confirmed',account,'Early paid monthly','monthly','EUR',versions,ids[1]);
 off_event:=public.edit_assumption(series.assumption_id,1,'{"enabled":false}',gen_random_uuid());
 on_event:=public.edit_assumption(series.assumption_id,2,'{"enabled":true}',gen_random_uuid());
 execute 'reset role';
 if not exists(select 1 from public.financial_assumptions where id=series.assumption_id and source='user' and enabled and recurring_evidence_eligible and starts_on='2026-03-31' and schedule_anchor_on='2026-01-31' and amount_minor=-9007199254740993) then raise exception 'Toggle lost early-payment fulfillment or schedule'; end if;
 if exists(select 1 from public.recurring_series where id=series.id and evidence_invalidated) or (select count(*) from public.recurring_series_transactions where series_id=series.id)<>3 then raise exception 'Toggle lost confirmed source links'; end if;
 execute 'set local role authenticated';
 override_event:=public.edit_assumption(series.assumption_id,3,'{"amount_minor":"-12345"}',gen_random_uuid());
 execute 'reset role';
 if (select recurring_evidence_eligible from public.financial_assumptions where id=series.assumption_id) then raise exception 'Amount override reused inferred fulfillment'; end if;
 execute 'set local role authenticated';
 perform public.undo_planning_event(override_event,4);
 execute 'set local role authenticated';
 override_event:=public.edit_assumption(series.assumption_id,5,'{"starts_on":"2026-04-15"}',gen_random_uuid());
 execute 'reset role';
 if not exists(select 1 from public.financial_assumptions where id=series.assumption_id and not recurring_evidence_eligible and schedule_anchor_on='2026-04-15') then raise exception 'Date override reused inferred fulfillment'; end if;
 execute 'set local role authenticated';
 perform public.undo_planning_event(override_event,6);
 execute 'set local role authenticated';
 override_event:=public.edit_assumption(series.assumption_id,7,'{"cadence":"quarterly"}',gen_random_uuid());
 execute 'reset role';
 if (select recurring_evidence_eligible from public.financial_assumptions where id=series.assumption_id) then raise exception 'Cadence override reused inferred fulfillment'; end if;
 execute 'set local role authenticated';
 perform public.undo_planning_event(override_event,8);
 perform public.undo_planning_event(on_event,9);
 perform public.undo_planning_event(off_event,10);
 execute 'reset role';
 if not exists(select 1 from public.financial_assumptions where id=series.assumption_id and source='recurring_confirmed' and recurring_evidence_eligible and enabled and version=11 and amount_minor=-9007199254740993) then raise exception 'Toggle/override Undo lost fulfillment history'; end if;
 if originals is distinct from (select jsonb_agg(to_jsonb(t) order by id) from public.transactions t where id=any(ids)) then raise exception 'Planning toggles rewrote paid source records'; end if;
 -- Current source invalidation still removes the source proof; manual schedule stays intentional.
 execute 'set local role authenticated';
 perform public.edit_assumption(series.assumption_id,11,'{"enabled":false}',gen_random_uuid());
 perform public.edit_assumption(series.assumption_id,12,'{"enabled":true}',gen_random_uuid());
 execute 'reset role';
 update public.transactions set description='Corrected source',version=version+1 where id=ids[3];
 if not exists(select 1 from public.recurring_series where id=series.id and evidence_invalidated) then raise exception 'Changed source retained automatic fulfillment proof'; end if;
 if not exists(select 1 from public.financial_assumptions where id=series.assumption_id and source='user' and enabled) then raise exception 'Changed evidence erased intentional schedule'; end if;
end;
$$;
