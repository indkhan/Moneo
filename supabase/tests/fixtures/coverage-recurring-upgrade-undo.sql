-- A schema addition must not alter original receipts or break owned Undo.
do $$
declare seeded public.qa_recurring_upgrade%rowtype;
begin
 select * into strict seeded from public.qa_recurring_upgrade;
 if seeded.original_receipt is distinct from (select to_jsonb(p) from public.planning_events p where id=seeded.event_id) then raise exception 'Migration rewrote original history'; end if;
 perform set_config('request.jwt.claim.sub',seeded.actor::text,true);
 execute 'set local role authenticated';
 perform public.undo_planning_event(seeded.event_id,seeded.expected_version);
 execute 'reset role';
 if not exists(select 1 from public.financial_assumptions where id=seeded.assumption_id and amount_minor=-1000 and schedule_anchor_on is null and version=3) then raise exception 'Pre-017 receipt Undo failed'; end if;
end;
$$;
