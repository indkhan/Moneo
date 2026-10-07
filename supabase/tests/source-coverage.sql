-- Synthetic source metadata must retain imports permission through atomic publication.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; denied uuid; unknown_job uuid; allowed uuid;
begin
  insert into auth.users(id,email) values(actor,'mne008-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into denied;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into unknown_job;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into allowed;
  insert into public.workspace_settings(workspace_id,ai_data_scopes) values(workspace,array['accounts','transactions']);
  execute 'set local role service_role';
  if public.finish_financial_review(denied,workspace,'Source coverage','Synthetic accepted-only review',
    '{"sourceCoverage":{"observedSourceRows":0,"importStatuses":{"failed":1}},"planning":{"unavailable":"disabled"}}',false)<>'canceled' then
    raise exception 'Revoked imports published source coverage' using errcode='ZX001';
  end if;
  if public.finish_financial_review(unknown_job,workspace,'Unknown source coverage','Synthetic accepted-only review',
    '{"sourceCoverage":{"observedSourceRows":null,"importStatuses":null,"financialCompleteness":"unknown"},"planning":{"unavailable":"disabled"}}',false)<>'completed' then
    raise exception 'Unknown source coverage unnecessarily required import permission' using errcode='ZX001';
  end if;
  execute 'reset role';
  if exists(select 1 from public.saved_analyses where job_id=denied) or
    not exists(select 1 from public.background_jobs where id=denied and stage='permissions_changed' and status='canceled') then
    raise exception 'Revocation did not atomically cancel without analysis' using errcode='ZX001';
  end if;
  update public.workspace_settings set ai_data_scopes=array['accounts','transactions','imports'] where workspace_id=workspace;
  execute 'set local role service_role';
  if public.finish_financial_review(allowed,workspace,'Permitted source coverage','Original source review',
    '{"sourceCoverage":{"observedSourceRows":1,"importStatuses":{"completed":1}},"planning":{"unavailable":"disabled"}}',false)<>'completed' then
    raise exception 'Permitted source metadata did not publish' using errcode='ZX001';
  end if;
  perform public.finish_financial_review(allowed,workspace,'Retry','Replacement', '{}',false);
  execute 'reset role';
  if (select count(*) from public.saved_analyses where job_id=allowed)<>1 or
    not exists(select 1 from public.saved_analyses where job_id=allowed and body='Original source review') then
    raise exception 'Publication retry replaced source history' using errcode='ZX001';
  end if;
end;
$$;
