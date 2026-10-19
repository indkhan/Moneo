-- Mirror lib/finance/balances.ts: a date-only balance is that day's closing balance (it already
-- includes the day's rows), and an older balance plus later activity is reported as the amount.
-- Reservations still require status 'current'.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.reservation_balance_evidence(uuid,timestamptz,text)'::regprocedure);
  if position('    elsif posting=boundary then
      return jsonb_build_object(''status'',''ambiguous'',''amount_minor'',null,''estimated_amount_minor'',null,''pending_hold_minor'',holds::text);' in definition)=0 then raise exception 'Expected same-day refusal absent'; end if;
  definition:=replace(definition,'    elsif posting=boundary then
      return jsonb_build_object(''status'',''ambiguous'',''amount_minor'',null,''estimated_amount_minor'',null,''pending_hold_minor'',holds::text);','    elsif posting=boundary then
      continue;');
  if position('''amount_minor'',case when status=''current'' then estimate::text end' in definition)=0 then raise exception 'Expected current-only amount absent'; end if;
  definition:=replace(definition,'''amount_minor'',case when status=''current'' then estimate::text end','''amount_minor'',estimate::text');
  execute definition;
end;
$$;
