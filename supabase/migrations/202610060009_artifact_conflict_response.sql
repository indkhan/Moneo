-- Permanent revision conflicts must not use serialization_failure: PostgREST
-- retries 40001 transactions. PT409 returns immediately as HTTP 409 instead.
-- Rewrite only the conflict code, retaining each deployed function's validation,
-- ownership checks, row lock, SECURITY DEFINER/search_path and existing ACLs.
do $$
declare signature text; target regprocedure; definition text;
begin
  foreach signature in array array[
    'public.save_generated_artifact_version(uuid,text,jsonb,text,text,uuid)',
    'public.rename_trusted_artifact(uuid,text,uuid)',
    'public.restore_trusted_artifact_version(uuid,uuid,uuid)',
    'public.save_validated_generated_artifact_version(uuid,uuid,text,jsonb,text,text,uuid)'
  ] loop
    target := to_regprocedure(signature);
    if target is null then
      raise exception 'Required artifact CAS function missing: %', signature;
    end if;
    definition := pg_get_functiondef(target);
    execute replace(definition, 'errcode=''40001''', 'errcode=''PT409''');
  end loop;
end;
$$;
