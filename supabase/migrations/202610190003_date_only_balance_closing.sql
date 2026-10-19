-- Mirror lib/finance/balances.ts: a date-only balance is that day's closing balance (it already
-- includes the day's rows), and an older balance plus later activity is reported as the amount.
-- Reservations still require status 'current'. Regex matching tolerates stored CRLF bodies.
do $$
declare definition text; patched text;
begin
  definition:=pg_get_functiondef('public.reservation_balance_evidence(uuid,timestamptz,text)'::regprocedure);
  patched:=regexp_replace(definition,'elsif posting=boundary then\s+return jsonb_build_object\(''status'',''ambiguous''[^;]*;','elsif posting=boundary then continue;');
  if patched=definition then raise exception 'Expected same-day refusal absent'; end if;
  definition:=patched;
  patched:=replace(definition,'''amount_minor'',case when status=''current'' then estimate::text end','''amount_minor'',estimate::text');
  if patched=definition then raise exception 'Expected current-only amount absent'; end if;
  execute patched;
end;
$$;
