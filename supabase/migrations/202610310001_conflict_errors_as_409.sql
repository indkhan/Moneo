-- PostgREST retries SQLSTATE 40001 (serialization_failure) inside the request until it succeeds,
-- so a function that raises 40001 for a deterministic "changed since you loaded it" conflict loops
-- forever and holds an API connection; a few such calls exhausted the pool and timed out every read.
-- Raise these conflicts as PT409 instead: PostgREST answers once with HTTP 409 and code PT409.
do $$
declare fn oid;
begin
  for fn in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc like '%''40001''%'
  loop
    execute replace(pg_get_functiondef(fn), '''40001''', '''PT409''');
  end loop;
end $$;

-- Proposals claimed by an auto-apply call that never returned stay "applying"; release them as failed.
update public.agent_proposals set status = 'failed', result = jsonb_build_object('error', 'Could not apply automatically; review it again')
where status = 'applying' and decided_at < now() - interval '1 hour';
