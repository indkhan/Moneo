do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; currency text; digits integer; expected text; record jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  if public.currency_minor_digits('ZZZ') is not null then raise exception 'Unknown currency precision guessed'; end if;
  foreach currency in array array['AFN','COP','HUF','IDR','MGA','IQD','CLF','JPY'] loop
    digits:=public.currency_minor_digits(currency);
    if digits is distinct from (case currency when 'IQD' then 3 when 'CLF' then 4 when 'JPY' then 0 else 2 end) then raise exception 'Incorrect accounting precision for %',currency; end if;
    expected:=round(1.125::numeric*power(10::numeric,digits))::text;
    record:=jsonb_build_object('kind','holding','name','Synthetic accounting units','currency_code',currency,'amount_minor',expected,'quantity_text','1','unit_price_text','1.125','as_of',(now() at time zone 'Europe/Berlin')::date);
    execute 'set local role authenticated';
    perform public.edit_wealth_item(gen_random_uuid(),0,record,false,gen_random_uuid());
    execute 'reset role';
  end loop;
end;
$$;
