do $$
declare actor uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid(); request_id uuid:=gen_random_uuid(); canceled_id uuid:=gen_random_uuid(); receipt jsonb; artifact public.artifacts%rowtype;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(other_actor,'qa-'||other_actor||'@example.invalid');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  artifact:=public.create_trusted_artifact('custom_comparison','Synthetic generated tool');
  receipt:=public.begin_artifact_generation(request_id,'calculator','Compare exact values',artifact.id);
  if receipt->>'status'<>'running' or (receipt->>'started')::boolean is distinct from true then raise exception 'Generation was not claimed'; end if;
  receipt:=public.begin_artifact_generation(request_id,'calculator','Compare exact values',artifact.id);
  if (receipt->>'started')::boolean is distinct from false then raise exception 'Generation retry duplicated provider work'; end if;
  begin
    perform public.begin_artifact_generation(request_id,'calculator','Different prompt',artifact.id);
    raise exception 'Generation idempotency payload changed' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  if public.finish_artifact_generation(request_id,'completed','{"source":"Exact source","validation":{"ok":true}}',null,'{"model_id":"free-model","input_tokens":null}')<>'completed' then raise exception 'Generation did not finish'; end if;
  perform public.finish_artifact_generation(request_id,'completed','{"source":"Different source"}',null,null);
  if not exists(select 1 from public.artifact_generation_requests where id=request_id and result->>'source'='Exact source') then raise exception 'Completed retry changed result'; end if;
  if public.cancel_artifact_generation(request_id)<>'completed' then raise exception 'Completed result disappeared on stop'; end if;
  perform public.begin_artifact_generation(canceled_id,'proposal','Create a reviewed planner',null);
  if public.cancel_artifact_generation(canceled_id)<>'canceled' then raise exception 'Cancellation not effective'; end if;
  if public.finish_artifact_generation(canceled_id,'completed','{"source":"Late result"}',null,null)<>'canceled' then raise exception 'Late generation overwrote cancellation'; end if;
  if exists(select 1 from public.artifact_generation_requests where id=canceled_id and result is not null) then raise exception 'Canceled generation stored a late result'; end if;
  begin
    perform public.begin_artifact_generation(null,'proposal','Valid prompt',null);
    raise exception 'Null request allowed' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub',other_actor::text,true);
  if exists(select 1 from public.artifact_generation_requests where id=request_id) then raise exception 'Foreign generation receipt visible'; end if;
  begin
    perform public.cancel_artifact_generation(request_id);
    raise exception 'Foreign generation canceled' using errcode='ZX001';
  exception when no_data_found then null; end;
  begin
    perform public.begin_artifact_generation(gen_random_uuid(),'calculator','Foreign tool',artifact.id);
    raise exception 'Foreign calculator generation allowed' using errcode='ZX001';
  exception when no_data_found then null; end;
  execute 'reset role';
end;
$$;
