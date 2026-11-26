create function public.refresh_import_statistics() returns void
language plpgsql security definer set search_path='' as $$
declare target regclass;
begin
  perform pg_catalog.pg_stat_force_next_flush();
  for target in select s.relid::regclass from pg_catalog.pg_stat_user_tables s join pg_catalog.pg_class c on c.oid=s.relid
    where s.relid in ('public.transactions'::regclass,'public.source_transactions'::regclass,'public.transaction_sources'::regclass,'public.balance_snapshots'::regclass)
      and s.n_live_tup>c.reltuples+greatest(c.reltuples,250) order by s.relid loop
    begin
      execute pg_catalog.format('lock table %s in share update exclusive mode nowait',target);
      execute pg_catalog.format('analyze %s',target);
    exception when lock_not_available then continue;
    end;
  end loop;
end;
$$;
revoke all on function public.refresh_import_statistics() from public,anon,authenticated,service_role;

do $$
declare definition text;
  batch_checked constant text:='if decisions_count<>jsonb_array_length(p_decisions) then raise exception ''Unexpected batch row decisions'' using errcode=''22023''; end if;';
begin
  definition:=pg_get_functiondef('public.ingest_import_batch(uuid,uuid,integer,integer,jsonb)'::regprocedure);
  if position(batch_checked in definition)=0 then raise exception 'Expected import batch decision check absent'; end if;
  execute replace(definition,batch_checked,batch_checked||E'\n  perform public.refresh_import_statistics();');
end;
$$;
